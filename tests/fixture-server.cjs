// Isolated UI fixture. Never connects to the production database.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const submissions = new Map();
const people = Array.from({length:4}, (_,i)=>({id:randomUUID(),name:`검증${i+1}`,team:'전도팀',prayer_request:'검증용 기도',created_at:new Date().toISOString(),edit_version:0}));
let revision=0, drawStartedAt=new Date(Date.now()-10000).toISOString();
let round={id:randomUUID(),mode:'team',targetSize:2,createdAt:new Date().toISOString(),groups:[{groupNumber:1,members:people.slice(0,2)},{groupNumber:2,members:people.slice(2)}]};
const server=http.createServer(async(req,res)=>{
  let body=''; for await(const chunk of req) body+=chunk;
  const data=body?JSON.parse(body):{};
  const url=new URL(req.url,'http://localhost');
  let result;
  if(url.pathname.endsWith('/prayer_snapshot')) result={participants:people,round,revision,drawStartedAt,serverTime:new Date().toISOString()};
  else if(url.pathname.endsWith('/participants')) result=people.find(p=>`eq.${p.id}`===url.searchParams.get('id'))??null;
  else if(url.pathname.endsWith('/prayer_register') || url.pathname.endsWith('/prayer_submit')){
    if (submissions.has(data.p_request_id)) {
      res.setHeader('content-type','application/json'); res.end(JSON.stringify(submissions.get(data.p_request_id))); return;
    }
    const p={id:randomUUID(),name:data.p_name,team:data.p_team,prayer_request:data.p_prayer,created_at:new Date().toISOString(),edit_version:0};
    people.push(p);
    revision++;result=p.id;
    if(data.p_request_id) submissions.set(data.p_request_id,p.id);
  } else if(url.pathname.endsWith('/prayer_edit')){
    const p=people.find(p=>p.id===data.p_id);
    if(!p||p.edit_version!==data.p_version){res.statusCode=409;result={code:'40001',message:'changed'};}
    else{Object.assign(p,{name:data.p_name,team:data.p_team,prayer_request:data.p_prayer,edit_version:p.edit_version+1});revision++;result=p.edit_version;}
  } else if(url.pathname.endsWith('/prayer_append')){
    if(data.p_revision!==revision){res.statusCode=409;result={code:'40001',message:'changed'};}
    else if(!round){res.statusCode=400;result={code:'P0002',message:'no groups'};}
    else {
      const assigned=new Set(round.groups.flatMap(g=>g.members.map(p=>p.id)));
      const pending=people.filter(p=>!assigned.has(p.id));
      for(const p of pending) [...round.groups].sort((a,b)=>a.members.length-b.members.length)[0].members.push(p);
      if(pending.length)revision++;result=pending.length;
    }
  } else if(url.pathname.endsWith('/prayer_command')){
    if(data.p_revision!==revision){res.statusCode=409;result={code:'40001',message:'changed'};}
    else if(data.p_operation==='draw'){drawStartedAt=new Date().toISOString();revision++;result=null;}
    else if(data.p_operation==='publish'){
      if(round && data.p_payload.confirm!=='재편성'){res.statusCode=400;result={message:'confirmation required'};}
      else {
        const groups=new Map();
        for(const a of data.p_payload.assignments){if(!groups.has(a.group_number))groups.set(a.group_number,{groupNumber:a.group_number,members:[]});groups.get(a.group_number).members.push(people.find(p=>p.id===a.participant_id));}
        round={id:randomUUID(),mode:data.p_payload.mode,targetSize:data.p_payload.target,createdAt:new Date().toISOString(),groups:[...groups.values()]};drawStartedAt=null;revision++;result=null;
      }
    }
    else {res.statusCode=400;result={message:'Unsupported fixture operation'};}
  } else {res.statusCode=404;result={message:'Unknown fixture endpoint'};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
});
server.listen(3031,'127.0.0.1',()=>{
  const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',process.env.FIXTURE_APP_PORT ?? '3030'],{
    stdio:'inherit',env:{...process.env,ADMIN_PASSWORD:'fixture-only-password',SUPABASE_URL:'http://127.0.0.1:3031',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:3031',NEXT_PUBLIC_SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service'},
  });
  process.on('SIGINT',()=>{app.kill();server.close();process.exit();});
});

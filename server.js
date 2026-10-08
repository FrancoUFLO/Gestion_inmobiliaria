'use strict';
const express=require('express');
const {Pool}=require('pg');
const crypto=require('node:crypto');
const path=require('node:path');
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(express.json({limit:'6mb'}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='require'?{rejectUnauthorized:false}:undefined});
const hash=p=>new Promise((resolve,reject)=>crypto.scrypt(p,Buffer.from('realestate-v19'),64,(e,k)=>e?reject(e):resolve(k.toString('hex'))));
const random=()=>crypto.randomBytes(32).toString('hex');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const emailOK=s=>/^\S+@\S+\.\S+$/.test(s||'');
const resendConfigured=()=>Boolean(process.env.RESEND_API_KEY&&process.env.RESEND_FROM);
async function sendVerificationEmail(to,code){
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:process.env.RESEND_FROM,to:[to],subject:'Verificá tu cuenta inmobiliaria',text:`Tu código de verificación es ${code}. Vence en 10 minutos.`})
  });
  if(!response.ok){const details=await response.text();console.error('Resend email delivery failed:',response.status,details.slice(0,1000));throw new Error('No se pudo enviar el código de verificación. Revisá Resend y sus variables.');}
}

const schema=`CREATE TABLE IF NOT EXISTS organizations(id uuid PRIMARY KEY, name text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL, verified boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS verifications(user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, code_hash text NOT NULL, expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, last_sent timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS server_audit(id bigserial PRIMARY KEY, user_id uuid, org_id uuid, action text NOT NULL, at timestamptz DEFAULT now());`;
let ready=pool.query(schema).then(()=>console.log('PostgreSQL ready')).catch(e=>{console.error('Database initialization failed',e);process.exitCode=1;});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const cookie=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('sid='))?.slice(4);
const auth=wrap(async(req,res,next)=>{const token=cookie(req);if(!token)return res.status(401).json({error:'Iniciá sesión.'});const r=await pool.query(`SELECT u.id,u.org_id,u.name,u.email,o.name AS organization FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.org_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.verified=true`,[sha(token)]);if(!r.rowCount)return res.status(401).json({error:'Sesión vencida.'});req.user=r.rows[0];req.token=token;next();});
const setCookie=(res,token)=>res.set('Set-Cookie',`sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
const clearCookie=res=>res.set('Set-Cookie','sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
const attempts=new Map();function limit(req,res,next){const key=req.ip+':'+req.path;const now=Date.now(),a=attempts.get(key)||{n:0,t:now};if(now-a.t>15*60e3){a.n=0;a.t=now;}if(++a.n>30)return res.status(429).json({error:'Demasiados intentos. Probá más tarde.'});attempts.set(key,a);next();}
app.use('/api/auth',limit);
app.post('/api/auth/register',wrap(async(req,res)=>{if(!resendConfigured())return res.status(503).json({error:'Falta configurar RESEND_API_KEY y RESEND_FROM para enviar códigos de verificación.'});const {organization,name,email,password}=req.body||{};if(!organization?.trim()||!name?.trim()||!emailOK(email)||typeof password!=='string'||password.length<12||password.length>128)return res.status(400).json({error:'Completá los datos. La contraseña debe tener entre 12 y 128 caracteres.'});const client=await pool.connect();try{await client.query('BEGIN');const org=crypto.randomUUID(),user=crypto.randomUUID(),code=String(crypto.randomInt(100000,1000000));await client.query('INSERT INTO organizations(id,name) VALUES($1,$2)',[org,organization.trim().slice(0,120)]);await client.query('INSERT INTO users(id,org_id,name,email,password_hash) VALUES($1,$2,$3,$4,$5)',[user,org,name.trim().slice(0,120),email.trim().toLowerCase(),await hash(password)]);await client.query(`INSERT INTO verifications(user_id,code_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`,[user,sha(code)]);await sendVerificationEmail(email.trim().toLowerCase(),code);await client.query('COMMIT');res.status(201).json({message:'Enviamos un código a tu correo.'});}catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'El correo ya está registrado.'});throw e;}finally{client.release();}}));
app.post('/api/auth/verify',wrap(async(req,res)=>{const {email,code}=req.body||{};if(!emailOK(email)||!/^[0-9]{6}$/.test(code||''))return res.status(400).json({error:'Datos inválidos.'});const r=await pool.query(`UPDATE users SET verified=true WHERE id=(SELECT u.id FROM users u JOIN verifications v ON v.user_id=u.id WHERE u.email=$1 AND v.code_hash=$2 AND v.expires_at>now() AND v.attempts<5) RETURNING id`,[email.toLowerCase(),sha(code)]);if(!r.rowCount){await pool.query(`UPDATE verifications SET attempts=attempts+1 FROM users u WHERE u.id=verifications.user_id AND u.email=$1`,[email.toLowerCase()]);return res.status(400).json({error:'Código incorrecto o vencido.'});}await pool.query('DELETE FROM verifications WHERE user_id=$1',[r.rows[0].id]);res.json({message:'Cuenta verificada. Ya podés ingresar.'});}));
app.post('/api/auth/login',wrap(async(req,res)=>{const {email,password}=req.body||{};if(typeof password!=='string'||!emailOK(email))return res.status(401).json({error:'Credenciales inválidas.'});const r=await pool.query('SELECT id,password_hash,verified FROM users WHERE email=$1',[email.toLowerCase()]);const expected=r.rows[0]?.password_hash||await hash('invalid-placeholder');const actual=await hash(password);if(!r.rowCount||!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(actual,'hex')))return res.status(401).json({error:'Credenciales inválidas.'});if(!r.rows[0].verified)return res.status(403).json({error:'Verificá tu correo antes de ingresar.'});const token=random();await pool.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')`,[sha(token),r.rows[0].id]);setCookie(res,token);res.json({ok:true});}));
app.post('/api/auth/logout',auth,wrap(async(req,res)=>{await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sha(req.token)]);clearCookie(res);res.json({ok:true});}));
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));
app.get('/api/state',auth,wrap(async(req,res)=>{const r=await pool.query('SELECT data,revision FROM organizations WHERE id=$1',[req.user.org_id]);res.json({data:r.rows[0].data,revision:Number(r.rows[0].revision)});}));
app.put('/api/state',auth,wrap(async(req,res)=>{const {data,revision}=req.body||{};if(!data||typeof data!=='object'||Array.isArray(data)||!Number.isSafeInteger(revision)||JSON.stringify(data).length>5e6)return res.status(400).json({error:'Datos inválidos o demasiado grandes.'});const fields=['properties','payments','receipts','contracts','trash','audit','backups'];if(fields.some(k=>!Array.isArray(data[k])))return res.status(400).json({error:'Estructura de datos inválida.'});for(const k of fields){if(data[k].some(item=>item.accountId&&item.accountId!==req.user.id))return res.status(403).json({error:'Registro de otra cuenta.'});}const clean={...data,accounts:[],currentAccount:null};const r=await pool.query('UPDATE organizations SET data=$1,revision=revision+1 WHERE id=$2 AND revision=$3 RETURNING revision',[JSON.stringify(clean),req.user.org_id,revision]);if(!r.rowCount)return res.status(409).json({error:'Hay cambios de otro dispositivo. Recargá para evitar sobrescribirlos.'});await pool.query('INSERT INTO server_audit(user_id,org_id,action) VALUES($1,$2,$3)',[req.user.id,req.user.org_id,'STATE_SAVE']);res.json({revision:Number(r.rows[0].revision)});}));
app.get('/api/health',wrap(async(req,res)=>{await pool.query('SELECT 1');res.json({status:'ok'});}));
app.use('/api',(req,res)=>res.status(404).json({error:'Ruta no encontrada.'}));
app.use(express.static(__dirname,{index:'index.html',dotfiles:'deny',setHeaders(res,file){if(file.endsWith('.html')||file.endsWith('.js'))res.setHeader('Cache-Control','no-store');}}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Error interno del servidor.'});});
const port=Number(process.env.PORT||3000);if(require.main===module)app.listen(port,'0.0.0.0',()=>console.log('v19 listening on',port));module.exports={app,ready};

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
const brevoConfigured=()=>Boolean(process.env.BREVO_API_KEY&&process.env.BREVO_FROM);
async function sendVerificationEmail(to,code){
  const sender=process.env.BREVO_FROM.trim();
  const response=await fetch('https://api.brevo.com/v3/smtp/email',{
    method:'POST',
    headers:{'accept':'application/json','api-key':process.env.BREVO_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({sender:{email:sender},to:[{email:to}],subject:'Verificá tu cuenta inmobiliaria',textContent:`Tu código de verificación es ${code}. Vence en 10 minutos.`})
  });
  if(!response.ok){
    const details=await response.text();
    console.error('Brevo email delivery failed:',response.status,details.slice(0,1000));
    throw new Error('Brevo rechazó el envío del código de verificación. Revisá el remitente autorizado y los logs de Railway.');
  }
}
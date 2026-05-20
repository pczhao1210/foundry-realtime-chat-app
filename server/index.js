// Clean minimal WebRTC-only server implementation
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { DefaultAzureCredential } from '@azure/identity';

dotenv.config();

const rootDir = path.resolve();
const cfgPath = path.join(rootDir,'config','config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath,'utf-8'));
const mcpCfgPath = path.join(rootDir,'config','mcp_config.json');
const DEFAULT_AZURE_AUTH_SCOPE = 'https://cognitiveservices.azure.com/.default';
const REALTIME_MODEL_OPTIONS = Object.freeze([
  'gpt-realtime-1',
  'gpt-realtime-2',
  'gpt-realtime-translation',
  'gpt-realtime-whisper'
]);
let azureIdentityCredentialCache = { cacheKey:'', credential:null };

function defaultMcpConfig(){
  return {
    enabled:false,
    serverUrl:'',
    serverLabel:'',
    authorization:'',
    requireApproval:'default',
    headers:{}
  };
}

function ensureMcpConfigFile(){
  try{
    fs.accessSync(mcpCfgPath, fs.constants.F_OK);
  }catch(_){
    const def=defaultMcpConfig();
    fs.writeFileSync(mcpCfgPath, JSON.stringify(def,null,2), 'utf-8');
  }
}

function loadMcpConfig(){
  ensureMcpConfigFile();
  try{
    const raw=fs.readFileSync(mcpCfgPath,'utf-8');
    const parsed=JSON.parse(raw);
    return { ...defaultMcpConfig(), ...parsed, headers: typeof parsed?.headers==='object' && !Array.isArray(parsed.headers) ? parsed.headers : {} };
  }catch(err){
    console.warn('[mcp] Failed to load config, falling back to default', err.message);
    return defaultMcpConfig();
  }
}

let mcpConfig = loadMcpConfig();

function sanitizeHeaders(input){
  if(!input || typeof input!=='object' || Array.isArray(input)) return {};
  const out={};
  Object.entries(input).forEach(([k,v])=>{
    if(v==null || v==='') return;
    out[String(k)] = String(v);
  });
  return out;
}

function normalizeRequireApproval(val){
  const allowed=['default','never','always'];
  if(!val) return 'default';
  const norm=String(val).toLowerCase();
  if(allowed.includes(norm)) return norm;
  throw new Error('invalid requireApproval value');
}

function sanitizeMcpPayload(payload){
  const base=defaultMcpConfig();
  if(!payload || typeof payload!=='object') return base;
  const enabled=Boolean(payload.enabled);
  const serverUrl=(payload.serverUrl??'').toString().trim();
  const serverLabel=(payload.serverLabel??'').toString().trim();
  const authorization=(payload.authorization??'').toString().trim();
  const requireApproval=normalizeRequireApproval(payload.requireApproval);
  const headers=sanitizeHeaders(payload.headers);
  if(authorization){ headers.Authorization = authorization; }
  const result={
    enabled: enabled && !!serverUrl,
    serverUrl,
    serverLabel,
    authorization,
    requireApproval,
    headers
  };
  return result;
}

function persistMcpConfig(newCfg){
  mcpConfig=newCfg;
  fs.writeFileSync(mcpCfgPath, JSON.stringify(newCfg,null,2), 'utf-8');
}

function getProvider(){ return (cfg.realtime.provider||'openai').toLowerCase(); }

function normalizeRealtimeModelName(value){
  return typeof value==='string' ? value.trim() : '';
}

function getRealtimeModelName(){
  return normalizeRealtimeModelName(cfg.realtime?.model || cfg.realtime?.deployment || '');
}

function getRealtimeModelOptions(){
  const options=[...REALTIME_MODEL_OPTIONS];
  const configured=getRealtimeModelName();
  if(configured && !options.includes(configured)) options.unshift(configured);
  return options;
}

function validateRealtimeModelName(value){
  const model=normalizeRealtimeModelName(value);
  if(!model) return '';
  const allowed=getRealtimeModelOptions();
  if(!allowed.includes(model)){
    throw new Error(`Invalid realtime model/deployment "${model}". Allowed values: ${allowed.join(', ')}`);
  }
  return model;
}

function getRequestedRealtimeModel(req){
  const raw=req.query.model ?? req.query.deployment;
  if(raw===undefined || raw===null || String(raw).trim()==='') return getRealtimeModelName();
  return validateRealtimeModelName(String(raw));
}

function getAzureConfig(){
  const rt = cfg.realtime || (cfg.realtime={});
  if(!rt.azure || typeof rt.azure!=='object' || Array.isArray(rt.azure)) rt.azure={};
  return rt.azure;
}

function normalizeAzureAuthMode(val){
  const norm=String(val||'api-key').trim().toLowerCase();
  if(['managed-identity','managed_identity','msi','entra'].includes(norm)) return 'managed-identity';
  return 'api-key';
}

function getAzureAuthMode(){ return normalizeAzureAuthMode(cfg.realtime?.authMode); }

function getAzureAuthScope(){
  const raw = getAzureConfig().authScope || DEFAULT_AZURE_AUTH_SCOPE;
  return String(raw).trim() || DEFAULT_AZURE_AUTH_SCOPE;
}

function getManagedIdentityClientId(){
  const azure=getAzureConfig();
  const raw = azure.managedIdentityClientId || azure.clientId || '';
  return String(raw).trim();
}

function getAzureTokenCredential(){
  const managedIdentityClientId=getManagedIdentityClientId();
  const cacheKey=managedIdentityClientId||'__default__';
  if(azureIdentityCredentialCache.credential && azureIdentityCredentialCache.cacheKey===cacheKey){
    return azureIdentityCredentialCache.credential;
  }
  const options=managedIdentityClientId ? { managedIdentityClientId } : {};
  const credential=new DefaultAzureCredential(options);
  azureIdentityCredentialCache={ cacheKey, credential };
  return credential;
}

function resolveApiKeyValue(){
  let key = cfg.realtime.apiKey || process.env[cfg.realtime.apiKeyEnv];
  if(!key && cfg.realtime.allowDirectKeyFallback){
    const cand=cfg.realtime.apiKeyEnv;
    if(/^(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{40,})$/.test(cand)){
      key=cand;
      console.warn('[realtime] Using apiKeyEnv value directly (fallback)');
    }
  }
  return key;
}

async function resolveAuthContext(){
  const provider=getProvider();
  if(provider==='azure'){
    const authMode=getAzureAuthMode();
    if(authMode==='managed-identity'){
      const token=await getAzureTokenCredential().getToken(getAzureAuthScope());
      if(!token?.token) throw new Error(`Failed to acquire Azure bearer token for scope ${getAzureAuthScope()}`);
      return { provider, authMode, credential:token.token };
    }
    const key=resolveApiKeyValue();
    if(!key) throw new Error('Missing API key env '+cfg.realtime.apiKeyEnv);
    return { provider, authMode:'api-key', credential:key };
  }
  const key=resolveApiKeyValue();
  if(!key) throw new Error('Missing API key env '+cfg.realtime.apiKeyEnv);
  return { provider, authMode:'api-key', credential:key };
}

async function validateRealtimeAuth(){
  const provider=getProvider();
  const authMode=provider==='azure' ? getAzureAuthMode() : 'api-key';
  if(provider==='azure' && authMode==='managed-identity'){
    const scope=getAzureAuthScope();
    const token=await getAzureTokenCredential().getToken(scope);
    if(!token?.token) throw new Error(`Failed to acquire Azure bearer token for scope ${scope}`);
    return {
      ok:true,
      provider,
      auth_mode:authMode,
      auth_scope:scope,
      managed_identity_client_id_configured:Boolean(getManagedIdentityClientId()),
      expires_on:token.expiresOnTimestamp || null
    };
  }
  const key=resolveApiKeyValue();
  if(!key) throw new Error('Missing API key env '+cfg.realtime.apiKeyEnv);
  return {
    ok:true,
    provider,
    auth_mode:'api-key',
    api_key_present:true,
    api_key_env:cfg.realtime.apiKeyEnv || null
  };
}

// env overrides
(function apply(){
  const rt = cfg.realtime || (cfg.realtime={});
  const env=process.env;
  const map=[['RT_PROVIDER','provider'],['RT_MODEL','model'],['RT_DEPLOYMENT','deployment'],['RT_ENDPOINT','endpoint'],['RT_API_VERSION','api_version'],['RT_KEY_ENV','apiKeyEnv'],['RT_AUTH_MODE','authMode'],['RT_VOICE','voice'],['RT_SYSTEM_PROMPT','system_prompt']];
  map.forEach(([k,f])=>{ if(env[k]) rt[f]=env[k]; });
  if(env.RT_AZURE_CLIENT_ID || env.RT_AZURE_AUTH_SCOPE){
    const azure = rt.azure && typeof rt.azure==='object' && !Array.isArray(rt.azure) ? rt.azure : (rt.azure={});
    if(env.RT_AZURE_CLIENT_ID) azure.managedIdentityClientId=env.RT_AZURE_CLIENT_ID;
    if(env.RT_AZURE_AUTH_SCOPE) azure.authScope=env.RT_AZURE_AUTH_SCOPE;
  }
  if(env.RT_TEMPERATURE){ const v=parseFloat(env.RT_TEMPERATURE); if(!Number.isNaN(v)) rt.temperature=v; }
  if(env.RT_MAX_TOKENS){ const v=parseInt(env.RT_MAX_TOKENS,10); if(!Number.isNaN(v)) rt.max_response_output_tokens=v; }
  if(env.RT_MODALITIES){ rt.modalities=env.RT_MODALITIES.split(/[,;\s]+/).filter(Boolean); }
  // 移除 input_audio_transcription 注入（产生 unknown_parameter 时禁用）
  if(env.RT_DEBUG){ rt.debug=!['0','false','no'].includes(env.RT_DEBUG.toLowerCase()); }
  if(env.RT_API_KEY){ rt.apiKey=env.RT_API_KEY; }
  if(!cfg.server) cfg.server={};
  if(env.RT_PORT){ const p=parseInt(env.RT_PORT,10); if(!Number.isNaN(p)) cfg.server.port=p; }
})();

function isAzure(){ return getProvider()==='azure'; }
function buildTrans(){ return undefined; }
function buildMcpTools(){
  if(!mcpConfig?.enabled || !mcpConfig.serverUrl) return undefined;
  const tool={ type:'mcp', server_url:mcpConfig.serverUrl };
  if(mcpConfig.serverLabel) tool.server_label=mcpConfig.serverLabel;
  // 避免同时出现 authorization 参数与 Authorization header 冲突，统一只用 headers.Authorization
  if(mcpConfig.authorization){
    tool.headers = tool.headers || {};
    if(!tool.headers.Authorization) tool.headers.Authorization = mcpConfig.authorization;
  }
  if(mcpConfig.requireApproval && mcpConfig.requireApproval!=='default') tool.require_approval=mcpConfig.requireApproval;
  if(mcpConfig.headers && Object.keys(mcpConfig.headers).length) tool.headers=mcpConfig.headers;
  return [tool];
}

function buildBody(modelOverride){ const b={ model:normalizeRealtimeModelName(modelOverride)||getRealtimeModelName(), voice:cfg.realtime.voice, modalities:cfg.realtime.modalities, temperature:cfg.realtime.temperature, max_response_output_tokens:cfg.realtime.max_response_output_tokens, instructions:cfg.realtime.system_prompt }; if(!b.model) delete b.model; return b; }
function resolveEndpoint(){
  const r=cfg.realtime||{};
  let ep=(r.endpoint||'').replace(/\/$/,'');
  if(r.session_endpoint) return r.session_endpoint;
  if(/\/sessions(\?|$)/.test(ep)) return ep;
  if(/\/realtime(\?|$)/.test(ep)) return ep.replace(/\/realtime(\?|$)/,'/realtime/sessions$1');
  if(/openai\.com/.test(ep) && !/azure\.com/.test(ep)){
    if(!/\/v1\b/.test(ep)) return ep + '/v1/realtime/sessions';
    if(/\/v1\b/.test(ep) && !/realtime/.test(ep)) return ep + '/realtime/sessions';
  }
  if(/azure\.com/.test(ep)){
    const av = r.api_version || r.apiVersion;
    const useV1 = (r.use_v1_path || process.env.RT_USE_V1_PATH==='1' || /^(true|yes)$/i.test(process.env.RT_USE_V1_PATH||''));
    if(useV1){
      // Force GA style path regardless of preview flag; api-version appended only if provided explicitly and not already present
      ep += '/openai/v1/realtime/sessions';
      if(av && !/[?&]api-version=/.test(ep)) ep += (ep.includes('?')?'&':'?') + 'api-version=' + encodeURIComponent(av);
      return ep;
    }
    // Non-GA path
    ep += '/openai/realtimeapi/sessions';
    if(av && !/[?&]api-version=/.test(ep)) ep += (ep.includes('?')?'&':'?') + 'api-version=' + encodeURIComponent(av);
    return ep;
  }
  return ep + '/sessions';
}
function buildAuthHeaders(authContext){ const headers={ 'Content-Type':'application/json','Accept':'application/json','OpenAI-Beta':'realtime=v1' }; if(authContext.provider==='azure' && authContext.authMode==='api-key') headers['api-key']=authContext.credential; else headers.Authorization=`Bearer ${authContext.credential}`; return headers; }

const app = express();
app.use(cors({ origin: cfg.server?.clientOrigin || '*' }));
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(rootDir,'public')));

// Expose a safe subset of realtime config (exclude api keys)
app.get('/api/realtime-config', (req,res)=>{
  const r=cfg.realtime||{};
  const safe={
    provider:r.provider,
    auth_mode:isAzure()?getAzureAuthMode():'api-key',
    model:r.model,
    deployment:r.deployment,
    model_options:getRealtimeModelOptions(),
    voice:r.voice,
    temperature:r.temperature,
    max_response_output_tokens:r.max_response_output_tokens,
    system_prompt:r.system_prompt,
    modalities:r.modalities,
    // input_audio_transcription removed
    vad: r.vad ? { enabled:r.vad.enabled, silence_ms:r.vad.silence_ms } : null,
    endpoint: r.endpoint,
    api_version: r.api_version || r.apiVersion
  };
  res.json(safe);
});

app.get('/api/realtime-auth-validation', async (req,res)=>{
  try{
    const result=await validateRealtimeAuth();
    res.json(result);
  }catch(err){
    res.status(500).json({
      ok:false,
      error:'Realtime auth validation failed',
      detail:err.message,
      provider:getProvider(),
      auth_mode:isAzure()?getAzureAuthMode():'api-key'
    });
  }
});

app.get('/api/mcp-config', (req,res)=>{
  res.json(mcpConfig);
});

app.post('/api/mcp-config', (req,res)=>{
  try{
    const sanitized=sanitizeMcpPayload(req.body);
    persistMcpConfig(sanitized);
    res.json({ ok:true, config:sanitized });
  }catch(err){
    console.error('[mcp] Failed to update config', err);
    res.status(400).json({ error: err.message });
  }
});

// 提供 WebSocket 直连所需 API Key（仅用于本地调试；生产请改用代理或 Entra 令牌）
app.get('/api/realtime-ws-key', (req,res)=>{
  try{
    if(isAzure() && getAzureAuthMode()==='managed-identity'){
      return res.status(400).json({ error:'WebSocket direct key helper is unavailable in managed-identity mode. Use WebRTC or switch to API key auth mode.' });
    }
    let key = resolveApiKeyValue();
    if(!key){ return res.status(500).json({ error:'Missing API key' }); }
    // 不返回全部信息结构，只返回必要字段
    res.json({ api_key: key, auth_mode:'api-key' });
  }catch(e){
    res.status(500).json({ error:'Failed to provide ws key', detail:e.message });
  }
});

// Diagnostics endpoint for quick troubleshooting

app.get('/api/realtime-session', async (req,res)=>{
  let requestedModel;
  try{
    requestedModel=getRequestedRealtimeModel(req);
  }catch(err){
    return res.status(400).json({ error:'Invalid realtime model/deployment', detail:err.message, allowed_models:getRealtimeModelOptions() });
  }
  let authContext;
  try{
    authContext=await resolveAuthContext();
  }catch(err){
    return res.status(500).json({ error:'Failed to resolve realtime credentials', detail:err.message, auth_mode:isAzure()?getAzureAuthMode():'api-key' });
  }
  // Allow runtime override for GA path (?use_v1=1 or 0)
  const prev = cfg.realtime.use_v1_path;
  const qUseV1 = req.query.use_v1;
  if(qUseV1==='1' || /^true$/i.test(qUseV1||'')) cfg.realtime.use_v1_path=true;
  else if(qUseV1==='0' || /^false$/i.test(qUseV1||'')) cfg.realtime.use_v1_path=false;
  let endpoint = resolveEndpoint();
  let attemptedVariant = /\/openai\/v1\/realtime\/sessions/.test(endpoint)? 'ga':'preview';
  // Restore previous flag after building endpoint (avoid persistent mutation)
  cfg.realtime.use_v1_path=prev;
  if(cfg.realtime.debug){ console.log('[realtime] resolved REST session endpoint (https) ->', endpoint); }
  const body = buildBody(requestedModel);
  try {
    console.log('[realtime] session.create payload:', JSON.stringify(body));
  } catch (_){ console.log('[realtime] session.create payload (non-serializable)'); }
  try {
  if(cfg.realtime.debug) console.log('[realtime] Creating REST session POST ->', endpoint, body);
    // If GA variant and contains api-version preview param, optionally strip to test GA without preview
    let firstEndpoint = endpoint;
    if(attemptedVariant==='ga'){
      // Remove api-version query for GA test (if present and contains preview)
      firstEndpoint = firstEndpoint.replace(/([?&])api-version=[^&]+(&?)/,'$1').replace(/[?&]$/,'');
      if(firstEndpoint!==endpoint && cfg.realtime.debug){ console.log('[realtime] Adjusted GA endpoint (stripped api-version):', firstEndpoint); }
    }
    let resp = await fetch(firstEndpoint,{ method:'POST', headers:buildAuthHeaders(authContext), body: JSON.stringify(body)});
    let text = await resp.text();
    // Fallback: if GA attempt returned 404 and a preview path is possible, retry preview
    if(attemptedVariant==='ga' && resp.status===404){
      console.warn('[realtime] GA path 404, attempting preview fallback...');
      // Build preview path explicitly
      const r=cfg.realtime; const base=(r.endpoint||'').replace(/\/$/,''); const av=r.api_version||r.apiVersion; let previewEp=base+'/openai/realtimeapi/sessions'; if(av && !/[?&]api-version=/.test(previewEp)) previewEp+=(previewEp.includes('?')?'&':'?')+'api-version='+encodeURIComponent(av);
      endpoint=previewEp; attemptedVariant='preview-fallback';
      if(cfg.realtime.debug) console.log('[realtime] Creating session (fallback) ->', endpoint, body);
      resp = await fetch(endpoint,{ method:'POST', headers:buildAuthHeaders(authContext), body: JSON.stringify(body)});
      text = await resp.text();
    }
    if(!resp.ok){
      console.error('[realtime] Session creation failed', resp.status, text.slice(0,400));
      let hint=''; if(resp.status===404) hint=' (检查 endpoint / api-version / 部署名称)'; else if(resp.status===401||resp.status===403) hint=authContext.provider==='azure' && authContext.authMode==='managed-identity' ? ' (检查 managed identity/Entra 令牌、角色分配与模型权限)' : ' (检查 API Key 权限与模型)';
      return res.status(500).json({ error:'Session create failed', status:resp.status, detail:text, hint });
    }
    let data; try { data=JSON.parse(text); } catch(e){ return res.status(500).json({ error:'Invalid JSON in session response', raw:text }); }
  if(data && !data.provider) data.provider=cfg.realtime.provider||'unknown';
  if(data) data.auth_mode_resolved=authContext.authMode;
  // Indicate which path style was actually used (GA v1 vs preview)
  const usedV1 = /\/openai\/v1\/realtime\/sessions/.test(endpoint);
  if(data) data.use_v1_path_resolved = usedV1;
  if(data) data.resolved_session_endpoint = endpoint;
  if(data) data.path_variant = attemptedVariant;
  // Inject base config hints for client URL building if missing
  if(data && !data.endpoint) data.endpoint = cfg.realtime.endpoint;
  if(data && !data.api_version && !data.apiVersion) data.api_version = cfg.realtime.api_version || cfg.realtime.apiVersion;
  if(data && !data.deployment) data.deployment = requestedModel || cfg.realtime.deployment || getRealtimeModelName();
  if(data && !data.model) data.model = requestedModel || getRealtimeModelName();
  if(isAzure() && !data?.client_secret?.value){ data._diagnostics={ note:'Azure session returned no client_secret; verify deployment supports realtime + api-version', keys:Object.keys(data)}; }
  res.json(data);
  } catch(e){
    console.error('[realtime] Exception creating session', e);
    res.status(500).json({ error:'Failed to create realtime session', detail:e.message });
  }
});

const port = cfg.server?.port || 3000;
const server = app.listen(port, ()=>{ console.log(`[realtime] Server listening on :${port}`); });

let shutting=false; function shutdown(sig){ if(shutting) return; shutting=true; console.log(`\n[realtime] Received ${sig}, shutting down...`); try{ server.close(()=>{ console.log('[realtime] HTTP server closed'); process.exit(0); }); setTimeout(()=>{ console.warn('[realtime] Force exit after timeout'); process.exit(0); },3000).unref(); }catch(e){ console.error('[realtime] Error during shutdown', e); process.exit(1);} }
['SIGINT','SIGTERM'].forEach(sig=>process.on(sig,()=>shutdown(sig)));

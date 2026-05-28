// Clean minimal WebRTC-only server implementation
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { DefaultAzureCredential } from '@azure/identity';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config({ quiet:true });

const rootDir = path.resolve();
const cfgPath = path.join(rootDir,'config','config.json');
const cfgExamplePath = path.join(rootDir,'config','config.example.json');
function readJsonConfig(primaryPath, fallbackPath){
  const sourcePath=fs.existsSync(primaryPath) ? primaryPath : fallbackPath;
  if(sourcePath!==primaryPath){
    console.warn(`[config] ${path.relative(rootDir, primaryPath)} not found; using ${path.relative(rootDir, fallbackPath)}. Copy the example file for local settings.`);
  }
  return JSON.parse(fs.readFileSync(sourcePath,'utf-8'));
}
const cfg = readJsonConfig(cfgPath, cfgExamplePath);
const mcpCfgPath = path.join(rootDir,'config','mcp_config.json');
const DEFAULT_AZURE_AUTH_SCOPE = 'https://cognitiveservices.azure.com/.default';
const DEFAULT_SPEECH_STYLE_INSTRUCTIONS = '# 口音与语音风格\n中文回答时使用自然、清晰、稳定的标准普通话；四声和轻声自然，句尾语气按中文习惯收束。语速中等偏自然，按中文语义短语断句，不要逐词停顿。不要使用英语式重音、夸张播音腔或外国人腔。口音控制不改变回答语言；不要因为用户口音切换语言。';
const DEFAULT_TRANSLATION_INSTRUCTIONS = '# 翻译约束\n翻译时优先保持专有名词、地名、人名和品牌名的官方常用译法，不要按字面误译或自行改写。若转写已明确识别出专有名词，翻译阶段应沿用该识别结果，并输出目标语言中的标准写法。示例：日本城市“横滨”翻译到英语时使用 “Yokohama”，翻译到日语时使用 “横浜”。';
const REALTIME_MODEL_OPTIONS = Object.freeze([
  'gpt-realtime-1',
  'gpt-realtime-1.5',
  'gpt-realtime-2',
  'gpt-realtime-translate',
  'gpt-realtime-whisper'
]);
const REALTIME_VOICE_OPTIONS = Object.freeze([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse'
]);
const REALTIME_TASK_OPTIONS = Object.freeze(['conversation','transcription','translation']);
let azureIdentityCredentialCache = { cacheKey:'', credential:null };
const DEFAULT_SPEECH_KEY_ENV = 'AZURE_SPEECH_KEY';
const DEFAULT_SPEECH_LANGUAGE = 'zh-CN';

function defaultMcpConfig(){
  return {
    servers:[]
  };
}

function defaultMcpServerConfig(){
  return {
    name:'',
    enabled:false,
    owner:'',
    transportType:'',
    serverUrl:'',
    serverLabel:'',
    serverDescription:'',
    projectConnectionId:'',
    allowedTools:[],
    authorization:'',
    requireApproval:'default',
    headers:{},
    enableKeepAlive:false
  };
}

function defaultWebSearchConfig(){
  return {
    enabled:false,
    type:'web_search',
    allowed_domains:[],
    user_location:null
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
    return sanitizeMcpPayload(parsed);
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

function splitAuthorizationHeader(headers, authorization=''){
  const cleanHeaders={};
  let auth=(authorization||'').toString().trim();
  Object.entries(headers||{}).forEach(([key,value])=>{
    if(/^authorization$/i.test(key)){
      if(!auth) auth=String(value||'').trim();
      return;
    }
    cleanHeaders[key]=value;
  });
  return { authorization:auth, headers:cleanHeaders };
}

function stringifyForLog(value){
  try{
    return JSON.stringify(value,(key,val)=>{
      if(/authorization|api[-_]?key|access[_-]?token|client[_-]?secret|secret|password/i.test(key)) return val ? '[redacted]' : val;
      if(typeof val==='string' && /^Bearer\s+/i.test(val)) return 'Bearer [redacted]';
      return val;
    });
  }catch(_){
    return '[unserializable]';
  }
}

function sanitizeStringList(input){
  if(Array.isArray(input)) return input.map(v=>String(v).trim()).filter(Boolean);
  if(typeof input==='string') return input.split(/[,;\n]+/).map(v=>v.trim()).filter(Boolean);
  return [];
}

function normalizeRequireApproval(val){
  const allowed=['default','never','always'];
  if(!val) return 'default';
  const norm=String(val).toLowerCase();
  if(allowed.includes(norm)) return norm;
  throw new Error('invalid requireApproval value');
}

function normalizeMcpTransportType(value, hasUrl=false){
  const fallback=hasUrl ? 'streamable-http' : '';
  if(value===undefined || value===null || String(value).trim()==='') return fallback;
  const norm=String(value).trim().toLowerCase();
  if(['streamable-http','http','sse','stdio'].includes(norm)) return norm;
  return String(value).trim();
}

function normalizeMcpServerKey(value, fallback='server'){
  const base=String(value||'').trim().replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
  return base || fallback;
}

function getNamedMcpServerEntries(payload){
  if(!payload || typeof payload!=='object' || Array.isArray(payload)) return null;
  if(payload.mcpServers && typeof payload.mcpServers==='object' && !Array.isArray(payload.mcpServers)){
    return Object.entries(payload.mcpServers);
  }
  if(payload.servers && typeof payload.servers==='object' && !Array.isArray(payload.servers)){
    return Object.entries(payload.servers);
  }
  return null;
}

function sanitizeMcpPayload(payload){
  const base=defaultMcpConfig();
  if(Array.isArray(payload)) return { servers:payload.map(sanitizeMcpServerPayload) };
  if(!payload || typeof payload!=='object') return base;
  const namedEntries=getNamedMcpServerEntries(payload);
  if(namedEntries) return { servers:namedEntries.map(([name,server])=>sanitizeMcpServerPayload(server, name)) };
  if(Array.isArray(payload.servers)) return { servers:payload.servers.map(sanitizeMcpServerPayload) };
  return { servers:[sanitizeMcpServerPayload(payload)] };
}

function sanitizeMcpServerPayload(payload, nameHint=''){
  const base=defaultMcpServerConfig();
  if(!payload || typeof payload!=='object' || Array.isArray(payload)) return base;
  const name=(payload.name ?? payload.serverName ?? nameHint ?? '').toString().trim();
  const enabled=Boolean(payload.enabled);
  const serverUrl=(payload.serverUrl ?? payload.url ?? '').toString().trim();
  const owner=(payload.owner ?? '').toString().trim();
  const transportType=normalizeMcpTransportType(payload.transportType ?? payload.type, !!serverUrl);
  const serverLabel=(payload.serverLabel ?? payload.label ?? payload.displayName ?? name ?? '').toString().trim();
  const serverDescription=(payload.serverDescription ?? payload.description ?? '').toString().trim();
  const projectConnectionId=(payload.projectConnectionId ?? payload.project_connection_id ?? '').toString().trim();
  const allowedTools=sanitizeStringList(payload.allowedTools ?? payload.allowed_tools);
  const authorization=(payload.authorization??'').toString().trim();
  const requireApproval=normalizeRequireApproval(payload.requireApproval ?? payload.require_approval);
  const { authorization:normalizedAuthorization, headers }=splitAuthorizationHeader(sanitizeHeaders(payload.headers), authorization);
  return {
    name,
    enabled: enabled && !!serverUrl,
    owner,
    transportType,
    serverUrl,
    serverLabel,
    serverDescription,
    projectConnectionId,
    allowedTools,
    authorization:normalizedAuthorization,
    requireApproval,
    headers,
    enableKeepAlive:Boolean(payload.enableKeepAlive)
  };
}

function getMcpServers(config=mcpConfig){
  if(Array.isArray(config?.servers)) return config.servers;
  if(config && typeof config==='object') return [sanitizeMcpServerPayload(config)];
  return [];
}

function serializeMcpConfig(config=mcpConfig){
  const servers=getMcpServers(config);
  const primary=servers[0] || defaultMcpServerConfig();
  const mcpServers={};
  servers.forEach((server,index)=>{
    const key=normalizeMcpServerKey(server.name || server.serverLabel || `server${index+1}`, `server${index+1}`);
    const { authorization, headers }=splitAuthorizationHeader(sanitizeHeaders(server.headers), server.authorization);
    if(authorization && !Object.keys(headers).some(header=>/^authorization$/i.test(header))) headers.Authorization=authorization;
    mcpServers[key]={
      enabled:!!server.enabled,
      owner:server.owner || '',
      type:server.transportType || (server.serverUrl ? 'streamable-http' : ''),
      url:server.serverUrl || '',
      headers,
      enableKeepAlive:!!server.enableKeepAlive,
      serverLabel:server.serverLabel || '',
      serverDescription:server.serverDescription || '',
      projectConnectionId:server.projectConnectionId || '',
      allowedTools:Array.isArray(server.allowedTools) ? server.allowedTools : [],
      requireApproval:server.requireApproval || 'default'
    };
  });
  return {
    ...primary,
    servers,
    mcpServers
  };
}

function normalizeHostedToolType(value){
  const type=String(value||'web_search').trim();
  if(type==='web_search' || type==='web_search_preview') return type;
  return 'web_search';
}

function getWebSearchConfig(){
  const raw=cfg.realtime?.web_search || cfg.realtime?.webSearch || {};
  const base=defaultWebSearchConfig();
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return base;
  const userLocation=raw.user_location && typeof raw.user_location==='object' && !Array.isArray(raw.user_location) ? raw.user_location : null;
  const normalizedLocation=userLocation ? {
    type:'approximate',
    country:String(userLocation.country||'').trim(),
    city:String(userLocation.city||'').trim(),
    region:String(userLocation.region||'').trim(),
    timezone:String(userLocation.timezone||'').trim()
  } : null;
  return {
    enabled:Boolean(raw.enabled),
    type:normalizeHostedToolType(raw.type),
    allowed_domains:sanitizeStringList(raw.allowed_domains || raw.allowedDomains),
    user_location: normalizedLocation && Object.keys(normalizedLocation).length>1 ? normalizedLocation : null
  };
}

function buildWebSearchTool(){
  const ws=getWebSearchConfig();
  if(!ws.enabled) return undefined;
  const tool={ type:ws.type };
  if(ws.allowed_domains.length) tool.filters={ allowed_domains:ws.allowed_domains };
  if(ws.user_location){
    const loc={ type:'approximate' };
    ['country','city','region','timezone'].forEach(key=>{ if(ws.user_location[key]) loc[key]=ws.user_location[key]; });
    tool.user_location=loc;
  }
  return tool;
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

function normalizeRealtimeTask(value){
  const task=typeof value==='string' ? value.trim().toLowerCase() : '';
  return REALTIME_TASK_OPTIONS.includes(task) ? task : 'conversation';
}

function getRequestedRealtimeTask(req){
  return normalizeRealtimeTask(req.query.task);
}

function realtimeTaskUsesVoice(task){
  return normalizeRealtimeTask(task)!=='transcription';
}

function realtimeTaskRequiresGa(task){
  return normalizeRealtimeTask(task)!=='conversation';
}

function normalizeRealtimeVoiceName(value){
  return typeof value==='string' ? value.trim().toLowerCase() : '';
}

function getRealtimeVoiceName(){
  return normalizeRealtimeVoiceName(cfg.realtime?.voice || '');
}

function getRealtimeVoiceOptions(){
  const options=[...REALTIME_VOICE_OPTIONS];
  const configured=getRealtimeVoiceName();
  if(configured && !options.includes(configured)) options.unshift(configured);
  return options;
}

function validateRealtimeVoiceName(value){
  const voice=normalizeRealtimeVoiceName(value);
  if(!voice) return '';
  const allowed=getRealtimeVoiceOptions();
  if(!allowed.includes(voice)){
    throw new Error(`Invalid realtime voice "${voice}". Allowed values: ${allowed.join(', ')}`);
  }
  return voice;
}

function getRequestedRealtimeVoice(req){
  const raw=req.query.voice;
  if(raw===undefined || raw===null || String(raw).trim()==='') return getRealtimeVoiceName();
  return validateRealtimeVoiceName(String(raw));
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

function getAzureTokenCredential(managedIdentityClientId=getManagedIdentityClientId()){
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

function getSpeechRootConfig(){
  const speech=cfg.speech && typeof cfg.speech==='object' && !Array.isArray(cfg.speech) ? cfg.speech : {};
  const realtimeSpeech=cfg.realtime?.speech && typeof cfg.realtime.speech==='object' && !Array.isArray(cfg.realtime.speech) ? cfg.realtime.speech : {};
  return { ...realtimeSpeech, ...speech };
}

function getAzureSpeechConfig(){
  const speech=getSpeechRootConfig();
  const nested=(speech.azureCognitive || speech.azure_cognitive || speech.azure || {});
  const azure=nested && typeof nested==='object' && !Array.isArray(nested) ? nested : {};
  const apiKeyEnv=String(speech.apiKeyEnv || azure.apiKeyEnv || DEFAULT_SPEECH_KEY_ENV).trim() || DEFAULT_SPEECH_KEY_ENV;
  const authMode=normalizeAzureAuthMode(speech.authMode || azure.authMode || 'api-key');
  const region=String(speech.region || azure.region || process.env.RT_SPEECH_REGION || process.env.AZURE_SPEECH_REGION || '').trim();
  const language=String(speech.language || azure.language || process.env.RT_SPEECH_LANGUAGE || DEFAULT_SPEECH_LANGUAGE).trim() || DEFAULT_SPEECH_LANGUAGE;
  const managedIdentityClientId=String(speech.managedIdentityClientId || azure.managedIdentityClientId || speech.clientId || azure.clientId || getManagedIdentityClientId() || '').trim();
  const resourceId=String(speech.resourceId || azure.resourceId || process.env.RT_SPEECH_RESOURCE_ID || '').trim();
  return {
    provider:String(speech.provider || process.env.RT_SPEECH_PROVIDER || 'none').trim().toLowerCase(),
    authMode,
    region,
    language,
    apiKeyEnv,
    apiKey:String(speech.apiKey || azure.apiKey || process.env.RT_SPEECH_API_KEY || process.env[apiKeyEnv] || '').trim(),
    authScope:String(speech.authScope || azure.authScope || DEFAULT_AZURE_AUTH_SCOPE).trim() || DEFAULT_AZURE_AUTH_SCOPE,
    managedIdentityClientId,
    resourceId
  };
}

function getSafeSpeechConfig(){
  const speech=getAzureSpeechConfig();
  const configured=Boolean(speech.region && (speech.apiKey || (speech.authMode==='managed-identity' && speech.resourceId)));
  return {
    provider:speech.provider,
    azure_cognitive:{
      enabled:configured,
      configured,
      region:speech.region,
      region_configured:Boolean(speech.region),
      auth_mode:speech.authMode,
      api_key_env:speech.apiKeyEnv,
      resource_id_configured:Boolean(speech.resourceId),
      language:speech.language
    }
  };
}

async function createAzureSpeechToken(){
  const speech=getAzureSpeechConfig();
  if(!speech.region) throw new Error('Missing Azure Speech region. Set speech.region or RT_SPEECH_REGION.');
  if(speech.authMode==='managed-identity'){
    if(!speech.resourceId) throw new Error('Missing Azure Speech resourceId for managed identity auth. Set speech.resourceId or RT_SPEECH_RESOURCE_ID.');
    const token=await getAzureTokenCredential(speech.managedIdentityClientId).getToken(speech.authScope);
    if(!token?.token) throw new Error(`Failed to acquire Azure Speech bearer token for scope ${speech.authScope}`);
    return { token:`aad#${speech.resourceId}#${token.token}`, region:speech.region, language:speech.language, auth_mode:'managed-identity', expires_on:token.expiresOnTimestamp || null };
  }
  if(!speech.apiKey) throw new Error(`Missing Azure Speech key. Set ${speech.apiKeyEnv} or speech.apiKey.`);
  const tokenEndpoint=`https://${encodeURIComponent(speech.region)}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  const resp=await fetch(tokenEndpoint,{ method:'POST', headers:{ 'Ocp-Apim-Subscription-Key':speech.apiKey, 'Content-Length':'0' } });
  const text=await resp.text();
  if(!resp.ok) throw new Error(`Azure Speech token request failed: HTTP ${resp.status} ${text.slice(0,200)}`);
  return { token:text, region:speech.region, language:speech.language, auth_mode:'api-key', expires_in:600 };
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
  if(env.RT_WEB_SEARCH || env.RT_WEB_SEARCH_ALLOWED_DOMAINS){
    const webSearch = rt.web_search && typeof rt.web_search==='object' && !Array.isArray(rt.web_search) ? rt.web_search : (rt.web_search={});
    if(env.RT_WEB_SEARCH) webSearch.enabled=/^(1|true|yes|on)$/i.test(env.RT_WEB_SEARCH);
    if(env.RT_WEB_SEARCH_ALLOWED_DOMAINS) webSearch.allowed_domains=sanitizeStringList(env.RT_WEB_SEARCH_ALLOWED_DOMAINS);
  }
  if(env.RT_AZURE_CLIENT_ID || env.RT_AZURE_AUTH_SCOPE){
    const azure = rt.azure && typeof rt.azure==='object' && !Array.isArray(rt.azure) ? rt.azure : (rt.azure={});
    if(env.RT_AZURE_CLIENT_ID) azure.managedIdentityClientId=env.RT_AZURE_CLIENT_ID;
    if(env.RT_AZURE_AUTH_SCOPE) azure.authScope=env.RT_AZURE_AUTH_SCOPE;
  }
  if(env.RT_SPEECH_PROVIDER || env.RT_SPEECH_REGION || env.RT_SPEECH_KEY_ENV || env.RT_SPEECH_AUTH_MODE || env.RT_SPEECH_LANGUAGE || env.RT_SPEECH_API_KEY || env.RT_SPEECH_RESOURCE_ID){
    const speech = cfg.speech && typeof cfg.speech==='object' && !Array.isArray(cfg.speech) ? cfg.speech : (cfg.speech={});
    if(env.RT_SPEECH_PROVIDER) speech.provider=env.RT_SPEECH_PROVIDER;
    if(env.RT_SPEECH_REGION) speech.region=env.RT_SPEECH_REGION;
    if(env.RT_SPEECH_KEY_ENV) speech.apiKeyEnv=env.RT_SPEECH_KEY_ENV;
    if(env.RT_SPEECH_AUTH_MODE) speech.authMode=env.RT_SPEECH_AUTH_MODE;
    if(env.RT_SPEECH_LANGUAGE) speech.language=env.RT_SPEECH_LANGUAGE;
    if(env.RT_SPEECH_API_KEY) speech.apiKey=env.RT_SPEECH_API_KEY;
    if(env.RT_SPEECH_RESOURCE_ID) speech.resourceId=env.RT_SPEECH_RESOURCE_ID;
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
  const tools=getMcpServers().filter(server=>server?.enabled && server.serverUrl).map(server=>{
    const tool={ type:'mcp', server_url:server.serverUrl };
    const serverLabel=(server.serverLabel || server.name || server.serverUrl || '').toString().trim();
    if(serverLabel) tool.server_label=serverLabel;
    if(server.requireApproval && server.requireApproval!=='default') tool.require_approval=server.requireApproval;
    if(!isAzure()){
      if(server.serverDescription) tool.server_description=server.serverDescription;
      if(server.projectConnectionId) tool.project_connection_id=server.projectConnectionId;
      if(Array.isArray(server.allowedTools) && server.allowedTools.length) tool.allowed_tools=server.allowedTools;
    }
    const { authorization, headers }=splitAuthorizationHeader(sanitizeHeaders(server.headers), server.authorization);
    if(authorization){
      if(isAzure()) headers.Authorization=authorization;
      else tool.authorization=authorization;
    }
    if(Object.keys(headers).length) tool.headers=headers;
    return tool;
  });
  return tools.length ? tools : undefined;
}

function buildRealtimeTools(){
  const tools=[];
  const webSearchTool=buildWebSearchTool();
  if(webSearchTool) tools.push(webSearchTool);
  const mcpTools=buildMcpTools();
  if(mcpTools) tools.push(...mcpTools);
  return tools.length ? tools : undefined;
}

function buildToolUseInstructions(){
  const tools=buildRealtimeTools();
  if(!tools?.length) return '';
  const hasMcp=tools.some(tool=>tool.type==='mcp');
  const hasWebSearch=tools.some(tool=>/^web_search/.test(tool.type||''));
  const lines=['工具使用规则: 只能使用当前会话 tools 中实际提供的工具，不要臆造、假装或模拟工具结果。'];
  if(hasMcp) lines.push('对于天气、地图、地理位置、路线、POI、实时状态等需要外部数据的查询，如果信息足够明确，应优先调用可用的 MCP 工具；缺少城市或地点时先追问。');
  if(hasWebSearch) lines.push('对于最新信息、网页事实或需要联网核验的问题，应使用 web_search 工具后再回答。');
  lines.push('工具调用失败时，简要说明无法获取实时数据，不要用训练知识编造当前天气、降雨概率或未来预报。');
  return lines.join('\n');
}

function mergeInstructions(base, extra){
  const normalizedBase=(base||'').toString().trim();
  const normalizedExtra=(extra||'').toString().trim();
  if(!normalizedExtra) return normalizedBase;
  return normalizedBase ? `${normalizedBase}\n\n${normalizedExtra}` : normalizedExtra;
}
function getSpeechStyleInstructions(){ const realtime=cfg.realtime||{}; const value=Object.prototype.hasOwnProperty.call(realtime,'speech_style_instructions') ? realtime.speech_style_instructions : DEFAULT_SPEECH_STYLE_INSTRUCTIONS; return (value||'').toString().trim(); }
function getTranslationInstructions(){ const realtime=cfg.realtime||{}; const value=Object.prototype.hasOwnProperty.call(realtime,'translation_instructions') ? realtime.translation_instructions : DEFAULT_TRANSLATION_INSTRUCTIONS; return (value||'').toString().trim(); }
function buildConversationInstructions(extra=''){ return mergeInstructions(mergeInstructions(cfg.realtime?.system_prompt, getSpeechStyleInstructions()), extra); }

function buildBody(modelOverride, voiceOverride, { includeVoice=true }={}){ const b={ model:normalizeRealtimeModelName(modelOverride)||getRealtimeModelName(), modalities:cfg.realtime.modalities, temperature:cfg.realtime.temperature, max_response_output_tokens:cfg.realtime.max_response_output_tokens, instructions:buildConversationInstructions() }; if(includeVoice) b.voice=normalizeRealtimeVoiceName(voiceOverride)||getRealtimeVoiceName(); if(!b.model) delete b.model; if(!b.voice) delete b.voice; if(!b.instructions) delete b.instructions; return b; }
function normalizeLanguageCode(value){ const lang=typeof value==='string' ? value.trim() : ''; return lang && lang.toLowerCase()!=='auto' ? lang : ''; }
function getRequestedInputLanguage(req){ return normalizeLanguageCode(req.query.input_language || req.query.inputLanguage); }
function getRequestedTargetLanguage(req){ return normalizeLanguageCode(req.query.target_language || req.query.targetLanguage) || 'en'; }
function getTranslationTranscriptionModel(){ return normalizeRealtimeModelName(cfg.realtime?.translation_transcription_model || cfg.realtime?.translationTranscriptionModel || cfg.realtime?.transcription_model || cfg.realtime?.transcriptionModel || 'gpt-realtime-whisper') || 'gpt-realtime-whisper'; }
function buildTranslationInputTranscription(inputLanguage){ const transcription={ model:getTranslationTranscriptionModel() }; if(inputLanguage && !isAzure()) transcription.language=inputLanguage; return transcription; }
function translationInstructionsSupported(){ return !isAzure(); }
function buildGaClientSecretEndpoint(task){ const base=(cfg.realtime?.endpoint||'').replace(/\/$/,''); if(!base) throw new Error('Missing realtime endpoint'); return base + (normalizeRealtimeTask(task)==='translation' ? '/openai/v1/realtime/translations/client_secrets' : '/openai/v1/realtime/client_secrets'); }
function buildGaClientSecretBody(task, modelOverride, voiceOverride, req){
  const requestedTask=normalizeRealtimeTask(task);
  const model=normalizeRealtimeModelName(modelOverride)||getRealtimeModelName();
  const inputLanguage=getRequestedInputLanguage(req);
  if(requestedTask==='transcription'){
    const transcription={ model };
    if(inputLanguage) transcription.language=inputLanguage;
    return { session:{ type:'transcription', audio:{ input:{ format:{ type:'audio/pcm', rate:24000 }, transcription, turn_detection:null } } } };
  }
  if(requestedTask==='translation'){
    const session={ model, audio:{ input:{ transcription:buildTranslationInputTranscription(inputLanguage) }, output:{ language:getRequestedTargetLanguage(req) } } };
    const instructions=getTranslationInstructions();
    if(translationInstructionsSupported() && instructions) session.instructions=instructions;
    return { session };
  }
  const session={ type:'realtime', model };
  const instructions=buildConversationInstructions();
  if(instructions) session.instructions=instructions;
  const voice=normalizeRealtimeVoiceName(voiceOverride)||getRealtimeVoiceName();
  if(voice) session.audio={ output:{ voice } };
  return { session };
}
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
function buildAuthHeaders(authContext,{ useGa=false }={}){ const headers={ 'Content-Type':'application/json','Accept':'application/json' }; if(!useGa) headers['OpenAI-Beta']='realtime=v1'; if(authContext.provider==='azure' && authContext.authMode==='api-key') headers['api-key']=authContext.credential; else headers.Authorization=`Bearer ${authContext.credential}`; return headers; }
function buildWebSocketAuthHeaders(authContext,{ useGa=false }={}){ const headers={}; if(!useGa) headers['OpenAI-Beta']='realtime=v1'; if(authContext.provider==='azure' && authContext.authMode==='api-key') headers['api-key']=authContext.credential; else headers.Authorization=`Bearer ${authContext.credential}`; return headers; }

function parseUseV1Flag(value){
  if(value==='1' || /^true$/i.test(value||'')) return true;
  if(value==='0' || /^false$/i.test(value||'')) return false;
  return Boolean(cfg.realtime?.use_v1_path || process.env.RT_USE_V1_PATH==='1' || /^(true|yes)$/i.test(process.env.RT_USE_V1_PATH||''));
}

function resolveRealtimeWebSocketEndpoint(model, useV1, task='conversation'){
  const r=cfg.realtime||{};
  const requestedTask=normalizeRealtimeTask(task);
  const deployment=validateRealtimeModelName(model || getRealtimeModelName());
  if(!deployment) throw new Error('Missing realtime model/deployment');
  let base=(r.endpoint||'').replace(/\/$/,'');
  if(!base) throw new Error('Missing realtime endpoint');
  base=base.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
  if(isAzure()){
    if(requestedTask==='translation') return { url:base + '/openai/v1/realtime/translations?model=' + encodeURIComponent(deployment), deployment, pathVariant:'translation-ga' };
    if(useV1 || realtimeTaskRequiresGa(requestedTask)) return { url:base + '/openai/v1/realtime?model=' + encodeURIComponent(deployment), deployment, pathVariant:requestedTask==='transcription'?'transcription-ga':'ga' };
    const apiVersion=(r.api_version || r.apiVersion || '2025-04-01-preview').trim();
    return { url:base + '/openai/realtime?api-version=' + encodeURIComponent(apiVersion) + '&deployment=' + encodeURIComponent(deployment), deployment, pathVariant:'preview' };
  }
  if(!/\/v1\b/.test(base)) base += '/v1';
  if(requestedTask==='translation') return { url:base + '/realtime/translations?model=' + encodeURIComponent(deployment), deployment, pathVariant:'translation' };
  return { url:base + '/realtime?model=' + encodeURIComponent(deployment), deployment, pathVariant:'openai' };
}

function closePair(a,b,code=1000,reason='proxy-close'){
  [a,b].forEach(ws=>{
    if(ws && ws.readyState!==WebSocket.CLOSED && ws.readyState!==WebSocket.CLOSING){
      try{ ws.close(code, reason); }catch(_){ }
    }
  });
}

async function connectRealtimeProxy(clientWs, req, url){
  const model=url.searchParams.get('model') || '';
  const task=getRequestedRealtimeTask({ query:{ task:url.searchParams.get('task')||'conversation' } });
  const useV1=realtimeTaskRequiresGa(task) || parseUseV1Flag(url.searchParams.get('use_v1'));
  let upstream;
  const pending=[];
  try{
    const authContext=await resolveAuthContext();
    const endpoint=resolveRealtimeWebSocketEndpoint(model, useV1, task);
    console.log(`[realtime-proxy] upstream connect path=${endpoint.pathVariant} auth=${authContext.authMode} deployment=${endpoint.deployment}`);
    upstream=new WebSocket(endpoint.url, ['realtime'], { headers:buildWebSocketAuthHeaders(authContext,{ useGa:endpoint.pathVariant!=='preview' }) });
    clientWs.on('message',(data,isBinary)=>{
      if(upstream.readyState===WebSocket.OPEN) upstream.send(data,{ binary:isBinary });
      else if(upstream.readyState===WebSocket.CONNECTING) pending.push([data,isBinary]);
    });
    upstream.on('open',()=>{
      while(pending.length){ const [data,isBinary]=pending.shift(); upstream.send(data,{ binary:isBinary }); }
    });
    upstream.on('message',(data,isBinary)=>{ if(clientWs.readyState===WebSocket.OPEN) clientWs.send(data,{ binary:isBinary }); });
    upstream.on('unexpected-response',(_request,response)=>{
      let body='';
      response.on('data',chunk=>{ body+=chunk.toString(); if(body.length>1200) body=body.slice(0,1200); });
      response.on('end',()=>{
        console.error('[realtime-proxy] upstream unexpected response', response.statusCode, response.statusMessage, body.slice(0,800));
        closePair(clientWs,upstream,1011,'upstream-unexpected-response');
      });
    });
    upstream.on('close',(code,buffer)=>{ const reason=buffer?.toString?.()||'upstream-close'; console.warn(`[realtime-proxy] upstream closed code=${code} reason=${reason}`); closePair(clientWs,null,code||1011,reason.slice(0,120)); });
    upstream.on('error',err=>{ console.error('[realtime-proxy] upstream error', err.message); closePair(clientWs,upstream,1011,'upstream-error'); });
    clientWs.on('close',(code,buffer)=>{ const reason=buffer?.toString?.()||'client-close'; closePair(upstream,null,code||1000,reason.slice(0,120)); });
    clientWs.on('error',()=>{ closePair(upstream,null,1011,'client-error'); });
  }catch(err){
    console.error('[realtime-proxy] failed to start', err.message);
    closePair(clientWs,upstream,1011,'proxy-start-failed');
  }
}

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
    voice_options:getRealtimeVoiceOptions(),
    temperature:r.temperature,
    max_response_output_tokens:r.max_response_output_tokens,
    system_prompt:r.system_prompt,
    speech_style_instructions:getSpeechStyleInstructions(),
    translation_instructions:getTranslationInstructions(),
    modalities:r.modalities,
    speech:getSafeSpeechConfig(),
    web_search:getWebSearchConfig(),
    // input_audio_transcription removed
    vad: r.vad ? { enabled:r.vad.enabled, silence_ms:r.vad.silence_ms } : null,
    endpoint: r.endpoint,
    api_version: r.api_version || r.apiVersion
  };
  res.json(safe);
});

app.get('/api/speech-token', async (_req,res)=>{
  try{
    const token=await createAzureSpeechToken();
    res.json(token);
  }catch(err){
    res.status(500).json({ error:'Failed to create Azure Speech token', detail:err.message, speech:getSafeSpeechConfig() });
  }
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
  res.json(serializeMcpConfig());
});

app.post('/api/mcp-config', (req,res)=>{
  try{
    const sanitized=sanitizeMcpPayload(req.body);
    persistMcpConfig(sanitized);
    res.json({ ok:true, config:serializeMcpConfig(sanitized) });
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
  let requestedVoice;
  const requestedTask=getRequestedRealtimeTask(req);
  const requestedMode=String(req.query.mode||'webrtc').toLowerCase();
  try{
    requestedModel=getRequestedRealtimeModel(req);
    requestedVoice=realtimeTaskUsesVoice(requestedTask) ? getRequestedRealtimeVoice(req) : '';
  }catch(err){
    return res.status(400).json({ error:'Invalid realtime session option', detail:err.message, allowed_models:getRealtimeModelOptions(), allowed_voices:getRealtimeVoiceOptions(), allowed_tasks:REALTIME_TASK_OPTIONS });
  }
  let authContext;
  try{
    authContext=await resolveAuthContext();
  }catch(err){
    return res.status(500).json({ error:'Failed to resolve realtime credentials', detail:err.message, auth_mode:isAzure()?getAzureAuthMode():'api-key' });
  }
  const requestedUseV1=realtimeTaskRequiresGa(requestedTask) || parseUseV1Flag(req.query.use_v1);
  if(requestedMode==='ws' || requestedMode==='websocket'){
    const data={
      provider:cfg.realtime.provider||'unknown',
      auth_mode_resolved:authContext.authMode,
      endpoint:cfg.realtime.endpoint,
      api_version:cfg.realtime.api_version || cfg.realtime.apiVersion,
      deployment:requestedModel || cfg.realtime.deployment || getRealtimeModelName(),
      model:requestedModel || getRealtimeModelName(),
      task:requestedTask,
      use_v1_path_resolved:requestedUseV1,
      path_variant:requestedTask==='translation'?'translation-ga':(requestedTask==='transcription'?'transcription-ga':(requestedUseV1?'ga':'preview')),
      resolved_session_endpoint:null
    };
    if(realtimeTaskUsesVoice(requestedTask)) data.voice=requestedVoice || getRealtimeVoiceName();
    return res.json(data);
  }
  if(isAzure() && requestedUseV1){
    let endpoint;
    let body;
    try{
      endpoint=buildGaClientSecretEndpoint(requestedTask);
      body=buildGaClientSecretBody(requestedTask, requestedModel, requestedVoice, req);
    }catch(err){
      return res.status(400).json({ error:'Invalid realtime session option', detail:err.message, allowed_models:getRealtimeModelOptions(), allowed_voices:getRealtimeVoiceOptions(), allowed_tasks:REALTIME_TASK_OPTIONS });
    }
    try{
      if(cfg.realtime.debug) console.log('[realtime] Creating GA client secret ->', endpoint, stringifyForLog(body));
      const resp=await fetch(endpoint,{ method:'POST', headers:buildAuthHeaders(authContext,{ useGa:true }), body:JSON.stringify(body) });
      const text=await resp.text();
      if(!resp.ok){
        console.error('[realtime] Client secret creation failed', resp.status, text.slice(0,400));
        let hint=''; if(requestedTask==='translation' && /token authentication/i.test(text)) hint=' (Azure 当前对 realtime translations client_secrets 拒绝 Entra/managed identity token auth；如需浏览器 WebRTC 翻译，可尝试 RT_AUTH_MODE=api-key 生成临时 client secret)'; else if(resp.status===404) hint=' (检查 GA endpoint / 部署名称 / translation endpoint)'; else if(resp.status===401||resp.status===403) hint=authContext.provider==='azure' && authContext.authMode==='managed-identity' ? ' (检查 managed identity/Entra 令牌、角色分配与模型权限)' : ' (检查 API Key 权限与模型)';
        return res.status(500).json({ error:'Client secret create failed', status:resp.status, detail:text, hint });
      }
      let data; try{ data=JSON.parse(text); }catch(_){ return res.status(500).json({ error:'Invalid JSON in client secret response', raw:text }); }
      if(data && data.value && !data.client_secret) data.client_secret={ value:data.value };
      if(data && !data.provider) data.provider=cfg.realtime.provider||'unknown';
      if(data) data.auth_mode_resolved=authContext.authMode;
      if(data) data.use_v1_path_resolved=true;
      if(data) data.resolved_session_endpoint=endpoint;
      if(data) data.path_variant=requestedTask==='translation'?'translation-ga':'ga';
      if(data && !data.endpoint) data.endpoint=cfg.realtime.endpoint;
      if(data && !data.deployment) data.deployment=requestedModel || cfg.realtime.deployment || getRealtimeModelName();
      if(data && !data.model) data.model=requestedModel || getRealtimeModelName();
      if(data) data.task=requestedTask;
      if(data && realtimeTaskUsesVoice(requestedTask) && !data.voice) data.voice=requestedVoice || getRealtimeVoiceName();
      return res.json(data);
    }catch(e){
      console.error('[realtime] Exception creating client secret', e);
      return res.status(500).json({ error:'Failed to create realtime client secret', detail:e.message });
    }
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
  const body = buildBody(requestedModel, requestedVoice, { includeVoice:realtimeTaskUsesVoice(requestedTask) });
  try {
    console.log('[realtime] session.create payload:', stringifyForLog(body));
  } catch (_){ console.log('[realtime] session.create payload (non-serializable)'); }
  try {
  if(cfg.realtime.debug) console.log('[realtime] Creating REST session POST ->', endpoint, stringifyForLog(body));
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
      if(cfg.realtime.debug) console.log('[realtime] Creating session (fallback) ->', endpoint, stringifyForLog(body));
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
  if(data) data.task = requestedTask;
  if(data && realtimeTaskUsesVoice(requestedTask) && !data.voice) data.voice = requestedVoice || getRealtimeVoiceName();
  if(isAzure() && !data?.client_secret?.value){ data._diagnostics={ note:'Azure session returned no client_secret; verify deployment supports realtime + api-version', keys:Object.keys(data)}; }
  res.json(data);
  } catch(e){
    console.error('[realtime] Exception creating session', e);
    res.status(500).json({ error:'Failed to create realtime session', detail:e.message });
  }
});

const port = cfg.server?.port || 3000;
const server = app.listen(port, ()=>{ console.log(`[realtime] Server listening on :${port}`); });
const realtimeProxyWss = new WebSocketServer({ noServer:true });
server.on('upgrade',(req,socket,head)=>{
  let url;
  try{ url=new URL(req.url,'http://localhost'); }catch(_){ socket.destroy(); return; }
  if(url.pathname!=='/realtime-proxy'){
    socket.destroy();
    return;
  }
  realtimeProxyWss.handleUpgrade(req,socket,head,ws=>{
    realtimeProxyWss.emit('connection',ws,req,url);
  });
});
realtimeProxyWss.on('connection',(ws,req,url)=>{ connectRealtimeProxy(ws,req,url); });

let shutting=false; function shutdown(sig){ if(shutting) return; shutting=true; console.log(`\n[realtime] Received ${sig}, shutting down...`); try{ server.close(()=>{ console.log('[realtime] HTTP server closed'); process.exit(0); }); setTimeout(()=>{ console.warn('[realtime] Force exit after timeout'); process.exit(0); },3000).unref(); }catch(e){ console.error('[realtime] Error during shutdown', e); process.exit(1);} }
['SIGINT','SIGTERM'].forEach(sig=>process.on(sig,()=>shutdown(sig)));

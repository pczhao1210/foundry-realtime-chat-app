const form=document.getElementById('mcpForm');
const serverIndexSelect=document.getElementById('serverIndex');
const btnAddServer=document.getElementById('btnAddServer');
const btnRemoveServer=document.getElementById('btnRemoveServer');
const serverNameInput=document.getElementById('serverName');
const serverLabelInput=document.getElementById('serverLabel');
const transportTypeSelect=document.getElementById('transportType');
const serverDescriptionInput=document.getElementById('serverDescription');
const serverUrlInput=document.getElementById('serverUrl');
const ownerInput=document.getElementById('owner');
const projectConnectionIdInput=document.getElementById('projectConnectionId');
const authorizationInput=document.getElementById('authorization');
const requireApprovalSelect=document.getElementById('requireApproval');
const allowedToolsTextarea=document.getElementById('allowedTools');
const headersTextarea=document.getElementById('headers');
const enableToolCheckbox=document.getElementById('enableTool');
const statusEl=document.getElementById('status');
const previewEl=document.getElementById('preview');
const btnTest=document.getElementById('btnTest');
const btnReset=document.getElementById('btnReset');
const enableKeepAliveCheckbox=document.getElementById('enableKeepAlive');
const DEFAULT_SERVER={
  name:'',
  enabled:false,
  owner:'',
  transportType:'streamable-http',
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
const DEFAULT_CFG={ servers:[] };
let selectedServerIndex=0;
let currentConfig=createEditableConfig();

function mapServerAliases(server={}){ const name=(server.name ?? server.serverName ?? '').toString().trim(); const serverUrl=(server.serverUrl ?? server.url ?? '').toString().trim(); const transportType=(server.transportType ?? server.type ?? (serverUrl ? 'streamable-http' : DEFAULT_SERVER.transportType)).toString().trim() || DEFAULT_SERVER.transportType; return { ...server, name, owner:(server.owner ?? '').toString().trim(), transportType, serverUrl, serverLabel:(server.serverLabel ?? server.label ?? server.displayName ?? name ?? '').toString().trim(), serverDescription:(server.serverDescription ?? server.description ?? '').toString().trim(), projectConnectionId:(server.projectConnectionId ?? server.project_connection_id ?? '').toString().trim(), requireApproval:(server.requireApproval ?? server.require_approval ?? DEFAULT_SERVER.requireApproval).toString().trim() || DEFAULT_SERVER.requireApproval, enableKeepAlive:Boolean(server.enableKeepAlive) }; }
function cloneServer(server=DEFAULT_SERVER){ const mapped=mapServerAliases(server); return { ...DEFAULT_SERVER, ...mapped, allowedTools: parseList(mapped?.allowedTools ?? mapped?.allowed_tools), headers: mapped?.headers && typeof mapped.headers==='object' && !Array.isArray(mapped.headers) ? { ...mapped.headers } : {} }; }
function createEditableConfig(cfg=DEFAULT_CFG){ const servers=Array.isArray(cfg?.servers) ? cfg.servers.map(cloneServer) : []; return { servers: servers.length ? servers : [cloneServer()] }; }

function setStatus(text,{color='#e6edf3',opacity=0.85}={}){
  statusEl.textContent=text;
  statusEl.style.color=color;
  statusEl.style.opacity=opacity;
}

function parseHeaders(raw){ if(!raw) return {}; const trimmed=raw.trim(); if(!trimmed) return {}; try{ const obj=JSON.parse(trimmed); if(obj && typeof obj==='object' && !Array.isArray(obj)) return obj; }catch(_){ /* fallthrough */ }
  const lines=trimmed.split(/\n+/); const headers={}; lines.forEach(line=>{ const idx=line.indexOf(':'); if(idx===-1) return; const key=line.slice(0,idx).trim(); const value=line.slice(idx+1).trim(); if(key) headers[key]=value; }); return headers; }
function parseList(raw){ if(Array.isArray(raw)) return raw.map(v=>String(v).trim()).filter(Boolean); if(!raw) return []; return String(raw).split(/[,;\n]+/).map(v=>v.trim()).filter(Boolean); }
function splitAuthorizationHeader(headers, authorization=''){ const cleanHeaders={}; let auth=(authorization||'').toString().trim(); Object.entries(headers||{}).forEach(([key,value])=>{ if(/^authorization$/i.test(key)){ if(!auth) auth=String(value||'').trim(); return; } cleanHeaders[key]=value; }); return { authorization:auth, headers:cleanHeaders }; }
function normalizeConfigPayload(cfg){ if(Array.isArray(cfg?.servers)) return { servers:cfg.servers.map(cloneServer) }; if(cfg?.mcpServers && typeof cfg.mcpServers==='object' && !Array.isArray(cfg.mcpServers)){ return { servers:Object.entries(cfg.mcpServers).map(([name,server])=>cloneServer({ ...server, name })) }; } if(cfg?.servers && typeof cfg.servers==='object' && !Array.isArray(cfg.servers)){ return { servers:Object.entries(cfg.servers).map(([name,server])=>cloneServer({ ...server, name })) }; } if(cfg && typeof cfg==='object' && (cfg.serverUrl || cfg.url || cfg.serverLabel || cfg.serverDescription || cfg.projectConnectionId || cfg.authorization || cfg.enabled || parseList(cfg.allowedTools || cfg.allowed_tools).length || Object.keys(cfg.headers||{}).length || cfg.name || cfg.owner || cfg.type || cfg.transportType)){ return { servers:[cloneServer(cfg)] }; } return { servers:[] }; }
function serverHasContent(server){ return !!(server.name || server.serverUrl || server.serverLabel || server.serverDescription || server.projectConnectionId || server.authorization || parseList(server.allowedTools).length || Object.keys(server.headers||{}).length || server.enabled || server.owner || (server.transportType && server.transportType!==DEFAULT_SERVER.transportType) || server.enableKeepAlive); }
function getEditableServers(){ return Array.isArray(currentConfig?.servers) && currentConfig.servers.length ? currentConfig.servers : [cloneServer()]; }
function getSelectedServer(){ return getEditableServers()[selectedServerIndex] || cloneServer(); }
function getServerDisplayName(server,index){ return server.name || server.serverLabel || server.serverUrl || `Server ${index+1}`; }
function buildToolFromServer(cfg){ if(!cfg.enabled || !cfg.serverUrl) return null; const tool={ type:'mcp' }; if(cfg.serverUrl) tool.server_url=cfg.serverUrl; if(cfg.serverLabel) tool.server_label=cfg.serverLabel; if(cfg.serverDescription) tool.server_description=cfg.serverDescription; if(cfg.projectConnectionId) tool.project_connection_id=cfg.projectConnectionId; const allowedTools=parseList(cfg.allowedTools); if(allowedTools.length) tool.allowed_tools=allowedTools; if(cfg.requireApproval && cfg.requireApproval!=='default') tool.require_approval=cfg.requireApproval; const normalized=splitAuthorizationHeader(cfg.headers||{}, cfg.authorization); if(normalized.authorization) tool.authorization='[已设置]'; if(Object.keys(normalized.headers).length) tool.headers=maskSensitiveHeaders(normalized.headers); return tool; }
function serializeConfigForSave(){ syncCurrentServerFromForm(); const servers=getEditableServers().map(cloneServer).filter(serverHasContent); return { servers }; }
function validateServers(servers){ return servers.every(server=>!serverHasContent(server) || !!server.serverUrl); }

function maskSensitiveHeaders(headers){ const out={}; Object.entries(headers||{}).forEach(([key,value])=>{ out[key]=/^authorization$/i.test(key)?'[已设置]':value; }); return out; }
function renderServerOptions(){ const servers=getEditableServers(); serverIndexSelect.innerHTML=''; servers.forEach((server,index)=>{ const option=document.createElement('option'); option.value=String(index); option.textContent=getServerDisplayName(server,index); serverIndexSelect.appendChild(option); }); serverIndexSelect.value=String(selectedServerIndex); btnRemoveServer.disabled=servers.length<=1; }
function renderPreview(cfg){ if(!previewEl) return; const servers=Array.isArray(cfg?.servers) ? cfg.servers : []; const arr=servers.map(buildToolFromServer).filter(Boolean); previewEl.textContent=JSON.stringify({ session:{ tools: arr } }, null, 2); }

function applyConfigToForm(cfg){ serverNameInput.value=cfg.name||'';
  transportTypeSelect.value=cfg.transportType||DEFAULT_SERVER.transportType;
  ownerInput.value=cfg.owner||'';
  serverLabelInput.value=cfg.serverLabel||'';
  serverDescriptionInput.value=cfg.serverDescription||'';
  serverUrlInput.value=cfg.serverUrl||'';
  projectConnectionIdInput.value=cfg.projectConnectionId||'';
  const normalized=splitAuthorizationHeader(cfg.headers||{}, cfg.authorization);
  authorizationInput.value=normalized.authorization||'';
  requireApprovalSelect.value=cfg.requireApproval||'default';
  allowedToolsTextarea.value=parseList(cfg.allowedTools).join('\n');
  const headersForDisplay={ ...normalized.headers };
  headersTextarea.value=Object.keys(headersForDisplay).length? JSON.stringify(headersForDisplay,null,2):'';
  enableToolCheckbox.checked=!!cfg.enabled;
  enableKeepAliveCheckbox.checked=!!cfg.enableKeepAlive;
}

function syncCurrentServerFromForm(){ const servers=getEditableServers().slice(); servers[selectedServerIndex]=collectFormData(); currentConfig={ servers }; renderServerOptions(); }

function applyCurrentServerToForm(){ const servers=getEditableServers(); if(selectedServerIndex>=servers.length) selectedServerIndex=Math.max(servers.length-1,0); renderServerOptions(); applyConfigToForm(getSelectedServer()); renderPreview(currentConfig); }

async function loadConfig(){ setStatus('正在加载配置…',{opacity:0.7});
  try{
    const resp=await fetch('/api/mcp-config',{ cache:'no-store' });
    if(!resp.ok) throw new Error('请求失败: '+resp.status);
    const cfg=await resp.json();
    currentConfig=createEditableConfig(normalizeConfigPayload(cfg));
    selectedServerIndex=0;
    applyCurrentServerToForm();
    setStatus('已加载配置',{color:'#7ee787'});
  }catch(err){
    console.error('[mcp] load failed', err);
    currentConfig=createEditableConfig();
    selectedServerIndex=0;
    applyCurrentServerToForm();
    setStatus('加载失败，使用默认值',{color:'#f85149'});
  }
}

function collectFormData(){ const headers=parseHeaders(headersTextarea.value);
  const cfg={
    name: serverNameInput.value.trim(),
    owner: ownerInput.value.trim(),
    transportType: transportTypeSelect.value||DEFAULT_SERVER.transportType,
    serverLabel: serverLabelInput.value.trim(),
    serverDescription: serverDescriptionInput.value.trim(),
    serverUrl: serverUrlInput.value.trim(),
    projectConnectionId: projectConnectionIdInput.value.trim(),
    authorization: authorizationInput.value.trim(),
    requireApproval: requireApprovalSelect.value||'default',
    allowedTools: parseList(allowedToolsTextarea.value),
    headers,
    enabled: enableToolCheckbox.checked,
    enableKeepAlive: enableKeepAliveCheckbox.checked
  };
  if(cfg.name==='') delete cfg.name;
  if(cfg.owner==='') delete cfg.owner;
  if(cfg.transportType===DEFAULT_SERVER.transportType) delete cfg.transportType;
  if(cfg.serverLabel==='') delete cfg.serverLabel;
  if(cfg.serverDescription==='') delete cfg.serverDescription;
  if(cfg.projectConnectionId==='') delete cfg.projectConnectionId;
  if(!cfg.allowedTools.length) delete cfg.allowedTools;
  if(cfg.authorization==='') delete cfg.authorization;
  if(!Object.keys(headers).length) delete cfg.headers;
  if(!cfg.enableKeepAlive) delete cfg.enableKeepAlive;
  return cfg;
}

function notifyParent(){ try{ window.opener?.postMessage({ type:'mcp-config-updated' }, '*'); }catch(_){ /* noop */ } }

async function persistConfig(cfg){ try{
    const resp=await fetch('/api/mcp-config',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(cfg) });
    if(!resp.ok){ const errBody=await resp.json().catch(()=>({})); throw new Error(errBody.error||('保存失败: '+resp.status)); }
    const data=await resp.json();
    currentConfig=createEditableConfig(normalizeConfigPayload(data.config));
    if(selectedServerIndex>=currentConfig.servers.length) selectedServerIndex=Math.max(currentConfig.servers.length-1,0);
    applyCurrentServerToForm();
    setStatus('已保存',{color:'#7ee787'});
    notifyParent();
  }catch(err){
    console.error('[mcp] save failed', err);
    setStatus(err.message||'保存失败',{color:'#f85149'});
  }
}

form.addEventListener('submit', (ev)=>{
  ev.preventDefault();
  const cfg=serializeConfigForSave();
  if(!validateServers(cfg.servers)){ alert('每个已填写的 MCP Server 都需要提供 URL。'); return; }
  if(!cfg.servers.length){ alert('当前没有可保存的 MCP Server，请先填写至少一个或使用“清除并禁用”。'); return; }
  persistConfig(cfg);
});

btnTest.addEventListener('click', ()=>{
  syncCurrentServerFromForm();
  const cfg=serializeConfigForSave();
  renderPreview(cfg);
  setStatus('已生成预览 (未保存)',{opacity:0.7});
});

serverIndexSelect.addEventListener('change', ()=>{
  const nextIndex=Math.max(parseInt(serverIndexSelect.value,10)||0,0);
  syncCurrentServerFromForm();
  selectedServerIndex=nextIndex;
  applyCurrentServerToForm();
});

btnAddServer.addEventListener('click', ()=>{
  syncCurrentServerFromForm();
  const servers=getEditableServers().slice();
  servers.push(cloneServer());
  currentConfig={ servers };
  selectedServerIndex=servers.length-1;
  applyCurrentServerToForm();
  setStatus('已新增 MCP Server，尚未保存',{opacity:0.7});
});

btnRemoveServer.addEventListener('click', ()=>{
  syncCurrentServerFromForm();
  const servers=getEditableServers().slice();
  if(servers.length<=1){
    currentConfig=createEditableConfig();
    selectedServerIndex=0;
  }else{
    servers.splice(selectedServerIndex,1);
    currentConfig={ servers };
    selectedServerIndex=Math.max(selectedServerIndex-1,0);
  }
  applyCurrentServerToForm();
  setStatus('已删除 MCP Server，尚未保存',{opacity:0.7});
});

btnReset.addEventListener('click', ()=>{
  if(!confirm('确定清除 MCP 配置并禁用吗？')) return;
  currentConfig=createEditableConfig();
  selectedServerIndex=0;
  applyCurrentServerToForm();
  persistConfig(DEFAULT_CFG);
});

document.addEventListener('DOMContentLoaded', ()=>{
  currentConfig=createEditableConfig();
  applyCurrentServerToForm();
  loadConfig();
});

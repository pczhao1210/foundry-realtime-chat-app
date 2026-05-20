const form=document.getElementById('mcpForm');
const serverLabelInput=document.getElementById('serverLabel');
const serverDescriptionInput=document.getElementById('serverDescription');
const serverUrlInput=document.getElementById('serverUrl');
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
const DEFAULT_CFG={
  enabled:false,
  serverUrl:'',
  serverLabel:'',
  serverDescription:'',
  projectConnectionId:'',
  allowedTools:[],
  authorization:'',
  requireApproval:'default',
  headers:{}
};

function setStatus(text,{color='#e6edf3',opacity=0.85}={}){
  statusEl.textContent=text;
  statusEl.style.color=color;
  statusEl.style.opacity=opacity;
}

function parseHeaders(raw){ if(!raw) return {}; const trimmed=raw.trim(); if(!trimmed) return {}; try{ const obj=JSON.parse(trimmed); if(obj && typeof obj==='object' && !Array.isArray(obj)) return obj; }catch(_){ /* fallthrough */ }
  const lines=trimmed.split(/\n+/); const headers={}; lines.forEach(line=>{ const idx=line.indexOf(':'); if(idx===-1) return; const key=line.slice(0,idx).trim(); const value=line.slice(idx+1).trim(); if(key) headers[key]=value; }); return headers; }
function parseList(raw){ if(Array.isArray(raw)) return raw.map(v=>String(v).trim()).filter(Boolean); if(!raw) return []; return String(raw).split(/[,;\n]+/).map(v=>v.trim()).filter(Boolean); }
function splitAuthorizationHeader(headers, authorization=''){ const cleanHeaders={}; let auth=(authorization||'').toString().trim(); Object.entries(headers||{}).forEach(([key,value])=>{ if(/^authorization$/i.test(key)){ if(!auth) auth=String(value||'').trim(); return; } cleanHeaders[key]=value; }); return { authorization:auth, headers:cleanHeaders }; }

function maskSensitiveHeaders(headers){ const out={}; Object.entries(headers||{}).forEach(([key,value])=>{ out[key]=/^authorization$/i.test(key)?'[已设置]':value; }); return out; }
function renderPreview(cfg){ if(!previewEl) return; const tool={ type:'mcp' }; if(cfg.serverUrl) tool.server_url=cfg.serverUrl; if(cfg.serverLabel) tool.server_label=cfg.serverLabel; if(cfg.serverDescription) tool.server_description=cfg.serverDescription; if(cfg.projectConnectionId) tool.project_connection_id=cfg.projectConnectionId; const allowedTools=parseList(cfg.allowedTools); if(allowedTools.length) tool.allowed_tools=allowedTools; if(cfg.requireApproval && cfg.requireApproval!=='default') tool.require_approval=cfg.requireApproval; const normalized=splitAuthorizationHeader(cfg.headers||{}, cfg.authorization); if(normalized.authorization) tool.authorization='[已设置]'; if(Object.keys(normalized.headers).length) tool.headers=maskSensitiveHeaders(normalized.headers); const arr=cfg.enabled && cfg.serverUrl ? [tool] : []; previewEl.textContent=JSON.stringify({ session:{ tools: arr } }, null, 2); }

function applyConfigToForm(cfg){ serverLabelInput.value=cfg.serverLabel||'';
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
  renderPreview(cfg);
}

async function loadConfig(){ setStatus('正在加载配置…',{opacity:0.7});
  try{
    const resp=await fetch('/api/mcp-config',{ cache:'no-store' });
    if(!resp.ok) throw new Error('请求失败: '+resp.status);
    const cfg=await resp.json();
    applyConfigToForm({ ...DEFAULT_CFG, ...cfg, headers: cfg.headers||{} });
    setStatus('已加载配置',{color:'#7ee787'});
  }catch(err){
    console.error('[mcp] load failed', err);
    applyConfigToForm(DEFAULT_CFG);
    setStatus('加载失败，使用默认值',{color:'#f85149'});
  }
}

function collectFormData(){ const headers=parseHeaders(headersTextarea.value);
  const cfg={
    serverLabel: serverLabelInput.value.trim(),
    serverDescription: serverDescriptionInput.value.trim(),
    serverUrl: serverUrlInput.value.trim(),
    projectConnectionId: projectConnectionIdInput.value.trim(),
    authorization: authorizationInput.value.trim(),
    requireApproval: requireApprovalSelect.value||'default',
    allowedTools: parseList(allowedToolsTextarea.value),
    headers,
    enabled: enableToolCheckbox.checked
  };
  if(cfg.serverLabel==='') delete cfg.serverLabel;
  if(cfg.serverDescription==='') delete cfg.serverDescription;
  if(cfg.projectConnectionId==='') delete cfg.projectConnectionId;
  if(!cfg.allowedTools.length) delete cfg.allowedTools;
  if(cfg.authorization==='') delete cfg.authorization;
  if(!Object.keys(headers).length) delete cfg.headers;
  return cfg;
}

function notifyParent(){ try{ window.opener?.postMessage({ type:'mcp-config-updated' }, '*'); }catch(_){ /* noop */ } }

async function persistConfig(cfg){ try{
    const resp=await fetch('/api/mcp-config',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(cfg) });
    if(!resp.ok){ const errBody=await resp.json().catch(()=>({})); throw new Error(errBody.error||('保存失败: '+resp.status)); }
    const data=await resp.json();
    applyConfigToForm({ ...DEFAULT_CFG, ...data.config });
    setStatus('已保存',{color:'#7ee787'});
    notifyParent();
  }catch(err){
    console.error('[mcp] save failed', err);
    setStatus(err.message||'保存失败',{color:'#f85149'});
  }
}

form.addEventListener('submit', (ev)=>{
  ev.preventDefault();
  const cfg=collectFormData();
  if(!cfg.serverUrl){ alert('请填写 MCP Server URL'); return; }
  persistConfig(cfg);
});

btnTest.addEventListener('click', ()=>{
  const cfg=collectFormData();
  renderPreview(cfg);
  setStatus('已生成预览 (未保存)',{opacity:0.7});
});

btnReset.addEventListener('click', ()=>{
  if(!confirm('确定清除 MCP 配置并禁用吗？')) return;
  persistConfig(DEFAULT_CFG);
});

document.addEventListener('DOMContentLoaded', ()=>{
  renderPreview(DEFAULT_CFG);
  loadConfig();
});

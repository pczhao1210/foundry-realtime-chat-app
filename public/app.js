// =========================
// WebRTC-ONLY REALTIME APP
// =========================
// Removed all WebSocket / relay / client-side VAD streaming paths.
// Responsibilities:
//  - Create realtime session (always with ?mode=webrtc)
//  - Establish WebRTC (audio + datachannel)
//  - Send/receive conversation + audio events over datachannel
//  - Optional server turn detection via session.update (server_vad)
//  - Optional server-side transcription, optional local Web Speech API STT

// ---- DOM ----
const logEl = document.getElementById('log');
// ---- Logging Verbosity Control ----
// Categories: sys,user,assistant,error,warn,diag,in,out,evt,raw,lat
// We will keep core (sys,user,assistant,error,warn) always. Others depend on flags.
let verboseDebug = false; // master switch for diag/in/out/evt/raw
let showLatencyLogs = false; // separate control for latency
// Expose toggles for console
Object.defineProperty(window,'__setVerbose', { value: v => { verboseDebug=!!v; console.log('[verboseDebug]',verboseDebug); } });
Object.defineProperty(window,'__setLatencyLog', { value: v => { showLatencyLogs=!!v; console.log('[showLatencyLogs]',showLatencyLogs); } });
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const micBtn = document.getElementById('micBtn');
const sendTextBtn = document.getElementById('sendTextBtn');
const textInput = document.getElementById('textInput');
const wave = document.getElementById('wave');
const modelInput = document.getElementById('model');
const connTypeSelect = document.getElementById('connType');
const tempInput = document.getElementById('temp');
const maxTokensInput = document.getElementById('maxTokens');
const voiceInput = document.getElementById('voice');
const systemPromptInput = document.getElementById('systemPrompt');
const enableServerTurnInput = document.getElementById('enableServerTurn');
const serverTurnThresholdInput = document.getElementById('serverTurnThreshold');
const serverTurnSilenceMsInput = document.getElementById('serverTurnSilenceMs');
const enableLocalStt = document.getElementById('enableLocalStt');
const autoSendStt = document.getElementById('autoSendStt');
// 模型端转写暂时禁用（unknown_parameter: session.input_audio_transcription）
const enableModelTranscription = { checked:false };
const modelTranscriptionLang = { value:'auto' };
const defaultTranscriptionModel = 'gpt-4o-mini-transcribe';
const DEFAULT_MODEL_OPTIONS=['gpt-realtime-1','gpt-realtime-2','gpt-realtime-translation','gpt-realtime-whisper'];
const btnMcpConfig = document.getElementById('btnMcpConfig');
const mcpStatusEl = document.getElementById('mcpStatus');
const DEFAULT_TEMPERATURE=0.7;
function safeNumber(val, fallback){ if(val===undefined||val===null||val==='') return fallback; const n=Number(val); return (Number.isFinite(n)? n : fallback); }
function isManagedIdentityMode(){ return (window._cfg?.auth_mode||'').toString().toLowerCase()==='managed-identity'; }
function normalizeModelValue(value){ return (value??'').toString().trim(); }
function mergeModelOptions(options, selected){ const merged=[]; [...(Array.isArray(options)?options:DEFAULT_MODEL_OPTIONS), selected].forEach(item=>{ const value=normalizeModelValue(item); if(value && !merged.includes(value)) merged.push(value); }); return merged.length?merged:DEFAULT_MODEL_OPTIONS.slice(); }
function setModelOptions(options, selected){ if(!modelInput || modelInput.tagName!=='SELECT') return; const merged=mergeModelOptions(options, selected); const selectedValue=normalizeModelValue(selected); modelInput.replaceChildren(...merged.map(value=>{ const opt=document.createElement('option'); opt.value=value; opt.textContent=value; return opt; })); modelInput.value=merged.includes(selectedValue)?selectedValue:merged[0]; }
function setModelValue(value){ if(!modelInput) return; const normalized=normalizeModelValue(value); if(!normalized) return; if(modelInput.tagName==='SELECT' && !Array.from(modelInput.options).some(opt=>opt.value===normalized)){ const opt=document.createElement('option'); opt.value=normalized; opt.textContent=normalized; modelInput.appendChild(opt); } modelInput.value=normalized; }
function getResolvedRealtimeModel(){
  const candidates=[modelInput?.value, sessionInfo?.deployment, sessionInfo?.model, window._cfg?.deployment, window._cfg?.model];
  for(const candidate of candidates){
    const value=(candidate??'').toString().trim();
    if(value) return value;
  }
  return '';
}
let mcpConfig=null;
function updateMcpStatus(){ if(!mcpStatusEl) return; if(!mcpConfig || !mcpConfig.serverUrl){ mcpStatusEl.textContent='MCP: 未配置'; return; } if(mcpConfig.enabled){ const label=mcpConfig.serverLabel||mcpConfig.serverUrl; mcpStatusEl.textContent=`MCP: ${label}`; } else { mcpStatusEl.textContent='MCP: 已保存(未启用)'; } }
async function refreshMcpConfig(){ try{ const resp=await fetch('/api/mcp-config',{ cache:'no-store' }); if(resp.ok){ mcpConfig=await resp.json(); } else { mcpConfig=null; } }catch(_){ mcpConfig=null; } updateMcpStatus(); }
function openMcpConfig(){ const w=window.open('/mcp.html','mcpConfig','width=520,height=640'); if(w) w.focus(); }
btnMcpConfig?.addEventListener('click', openMcpConfig);
window.addEventListener('message', ev=>{ if(ev?.data?.type==='mcp-config-updated'){ refreshMcpConfig(); }});
updateMcpStatus();

function buildMcpToolsPayload(){ if(!mcpConfig || !mcpConfig.serverUrl) return null; if(!mcpConfig.enabled) return []; const tool={ type:'mcp', server_url:mcpConfig.serverUrl }; if(mcpConfig.serverLabel) tool.server_label=mcpConfig.serverLabel; if(mcpConfig.requireApproval && mcpConfig.requireApproval!=='default') tool.require_approval=mcpConfig.requireApproval; if(mcpConfig.headers && typeof mcpConfig.headers==='object' && Object.keys(mcpConfig.headers).length){ tool.headers=mcpConfig.headers; }
  if(mcpConfig.authorization){ tool.headers = tool.headers || {}; if(!tool.headers.Authorization) tool.headers.Authorization = mcpConfig.authorization; }
  return [tool];
}
// ---- Config hydration ----
let initialConfigLoaded=false;
// ---- UI Helpers (moved earlier so hydrateConfig can use log) ----
function log(role, content){
  // Filter based on verbosity
  const noisy = ['diag','in','out','evt','raw','lat'];
  if(noisy.includes(role)){
    if(role==='lat' && !showLatencyLogs) return;
    if(role!=='lat' && !verboseDebug) return;
  }
  if(content==null) content='';
  else if(typeof content==='object'){
    try{content=JSON.stringify(content,null,2);}catch(_){content=String(content);} }
  const div=document.createElement('div');
  div.className='msg';
  const r=document.createElement('span'); r.className='role'; r.textContent=role+':';
  div.appendChild(r);
  const span=document.createElement('span'); span.textContent=content; div.appendChild(span);
  logEl.appendChild(div); logEl.scrollTop=logEl.scrollHeight;
}
function setStatus(s){ statusEl.textContent=s; }
window.onerror=function(msg,src,line,col,err){ try{ log('error','JS错误: '+msg+' @'+line+':'+col+(err&&err.message?(' '+err.message):'')); }catch(_){} };
function applyConfig(c,{force=false}={}){
  if(!c || typeof c!=='object') return;
  const assignments=[];
  if(modelInput){ const configuredModel=normalizeModelValue(c.model||c.deployment||''); const shouldApplyModel=force || !initialConfigLoaded || !modelInput.value; const selectedModel=shouldApplyModel ? configuredModel : modelInput.value; const beforeModel=modelInput.value; setModelOptions(c.model_options, selectedModel); if(shouldApplyModel) setModelValue(configuredModel); if(modelInput.value && (modelInput.value!==beforeModel || shouldApplyModel)) assignments.push('model='+modelInput.value); }
  if(force || (!voiceInput.value && c.voice)){ voiceInput.value=c.voice||''; assignments.push('voice='+voiceInput.value); }
  if(force || (!tempInput.value && (c.temperature!==undefined))){ tempInput.value=(c.temperature!==undefined? c.temperature : ''); assignments.push('temp='+tempInput.value); }
  if(force || (!maxTokensInput.value && c.max_response_output_tokens)){ maxTokensInput.value=c.max_response_output_tokens||''; assignments.push('max_tokens='+maxTokensInput.value); }
  if(force || (systemPromptInput && !systemPromptInput.value && c.system_prompt)){ systemPromptInput.value=c.system_prompt||''; assignments.push('system_prompt(len='+(c.system_prompt?c.system_prompt.length:0)+')'); }
  // 已禁用 input_audio_transcription UI 同步
  if(assignments.length) log('sys',(force?'强制':'条件')+'配置赋值: '+assignments.join(', '));
}

async function hydrateConfig(){
  try{
    log('sys','hydrateConfig 开始');
    const r=await fetch('/api/realtime-config');
    if(!r.ok){ log('error','realtime-config 请求失败 HTTP '+r.status); return; }
    const c=await r.json(); window._cfg=c;
    applyConfig(c,{force:false});
  log('sys','模型端转写功能已禁用(不发送到服务器)');
    initialConfigLoaded=true;
  }catch(err){ log('error','hydrateConfig 异常: '+err.message); }
  finally {
    await refreshMcpConfig();
    if(!modelInput.value){ log('sys','模型仍为空, 请从下拉菜单选择部署名'); }
    log('sys','hydrateConfig 结束');
  }
}
hydrateConfig();
document.getElementById('btnReloadCfg')?.addEventListener('click',()=>{ log('sys','手动刷新配置触发'); hydrateConfig(); });
document.getElementById('btnResetCfg')?.addEventListener('click',()=>{ if(window._cfg){ log('sys','重置配置(强制覆盖当前输入)'); applyConfig(window._cfg,{force:true}); } else { log('error','当前尚无 _cfg 数据, 请先刷新配置'); } });

// ---- State ----
let sessionInfo=null; let pc=null; let dataChannel=null; let remoteAudioEl=null; let webrtcKey=null; let webrtcActive=false;
let activeConnType=null; // 'websocket' | 'webrtc'
let audioStream=null; let isRecording=false; let recognition=null; let sttActive=false; let transcriptionModel=defaultTranscriptionModel; let activeResponse=false;
const AUDIO_SAMPLE_RATE=24000; let audioPlayCtx=null; let audioPlayHead=0; let audioTranscriptPartial=''; let _audioTranscriptDivPartial=null;
let analyser=null; let audioCtxVis=null; let rafId=null;
// Response tracking (for cancellation)
let activeResponseId=null; // current in-progress response id
let assistantAudioStreaming=false; // true while response.output_audio.delta events are arriving
let autoInterruptEnabled=true; // default on, can expose toggle later
Object.defineProperty(window,'__setAutoInterrupt',{ value:v=>{ autoInterruptEnabled=!!v; console.log('[autoInterruptEnabled]',autoInterruptEnabled); }});
let autoInterruptConsecFrames=4; // 需要连续多少帧语音活动才触发打断
Object.defineProperty(window,'__setAutoInterruptFrames',{ value:n=>{ const v=parseInt(n,10); if(Number.isFinite(v)&&v>0){ autoInterruptConsecFrames=v; console.log('[autoInterruptConsecFrames]',autoInterruptConsecFrames);} }});
let consecutiveVoiceFrames=0;
let interjectionActive=false; // 防止重复插话
let cancelInFlight=false; // 防止重复发送 response.cancel
let responseCreatedAt=0; // 记录最近一次 response.created 的时间戳 (performance.now)
// ---- 本地简易 VAD 参数 (RMS 基于时域数据) ----
let vadRmsThreshold=0.04; // 默认阈值 (0~1). 噪声较大环境可调高 (例如 0.06)
let vadMinSilenceFrames=2; // 多少连续静音帧后重置连续语音计数
let silenceFrameCount=0;
Object.defineProperty(window,'__setVadThreshold',{ value:v=>{ const f=parseFloat(v); if(Number.isFinite(f)&&f>0){ vadRmsThreshold=f; console.log('[vadRmsThreshold]',vadRmsThreshold); } }});
Object.defineProperty(window,'__setVadSilenceReset',{ value:n=>{ const v=parseInt(n,10); if(Number.isFinite(v)&&v>=0){ vadMinSilenceFrames=v; console.log('[vadMinSilenceFrames]',vadMinSilenceFrames); } }});
// ---- Latency instrumentation ----
let latencyTurnCounter=0; // incremental id for each speech turn
let latencyCurrentTurn=null; // { id, tMicStart, tVoiceStartDetected, tFirstTextDelta, tFirstAudioDelta, tFirstAudioPlay, metricsEmitted }
const latencyHistory=[]; // array of past metrics
function nowMs(){ return performance.now(); }
function startLatencyTurn(){ latencyTurnCounter++; latencyCurrentTurn={ id:latencyTurnCounter, tMicStart: nowMs(), metricsEmitted:false }; if(document.getElementById('enableLatencyLog')?.checked) log('lat','启动语音回合 #'+latencyCurrentTurn.id); }
function ensureLatencyVoiceStart(){ if(latencyCurrentTurn && !latencyCurrentTurn.tVoiceStartDetected){ latencyCurrentTurn.tVoiceStartDetected=nowMs(); } }
function markLatency(event){ if(!latencyCurrentTurn) return; const t=nowMs(); if(event==='text' && !latencyCurrentTurn.tFirstTextDelta){ latencyCurrentTurn.tFirstTextDelta=t; }
  if(event==='audioDelta' && !latencyCurrentTurn.tFirstAudioDelta){ latencyCurrentTurn.tFirstAudioDelta=t; }
  if(event==='audioPlay' && !latencyCurrentTurn.tFirstAudioPlay){ latencyCurrentTurn.tFirstAudioPlay=t; emitLatencyMetrics(true); }
}
function emitLatencyMetrics(force){ if(!latencyCurrentTurn || latencyCurrentTurn.metricsEmitted) return; const lt=latencyCurrentTurn; if(!force && !lt.tFirstAudioPlay) return; lt.metricsEmitted=true; const base=lt.tVoiceStartDetected||lt.tMicStart; const metrics={ id:lt.id, fromVoiceStart_ms:{ text: lt.tFirstTextDelta? (lt.tFirstTextDelta-base):null, audioDelta: lt.tFirstAudioDelta? (lt.tFirstAudioDelta-base):null, audioPlay: lt.tFirstAudioPlay? (lt.tFirstAudioPlay-base):null }, fromMicStart_ms:{ text: lt.tFirstTextDelta? (lt.tFirstTextDelta-lt.tMicStart):null, audioDelta: lt.tFirstAudioDelta? (lt.tFirstAudioDelta-lt.tMicStart):null, audioPlay: lt.tFirstAudioPlay? (lt.tFirstAudioPlay-lt.tMicStart):null } };
  latencyHistory.push(metrics); if(document.getElementById('enableLatencyLog')?.checked) log('lat','回合#'+lt.id+' 延迟(ms) '+JSON.stringify(metrics.fromVoiceStart_ms)); window._lastLatency=metrics; }
window.getLatencyHistory=()=>latencyHistory.slice();
window.printLatencySummary=()=>{ if(!latencyHistory.length){ console.log('无延迟数据'); return; } const agg={ text:0,audioDelta:0,audioPlay:0,cntText:0,cntAudioDelta:0,cntAudioPlay:0 }; latencyHistory.forEach(m=>{ if(m.fromVoiceStart_ms.text!=null){ agg.text+=m.fromVoiceStart_ms.text; agg.cntText++; } if(m.fromVoiceStart_ms.audioDelta!=null){ agg.audioDelta+=m.fromVoiceStart_ms.audioDelta; agg.cntAudioDelta++; } if(m.fromVoiceStart_ms.audioPlay!=null){ agg.audioPlay+=m.fromVoiceStart_ms.audioPlay; agg.cntAudioPlay++; } }); const avg={ text: agg.cntText? (agg.text/agg.cntText).toFixed(1):'-', audioDelta: agg.cntAudioDelta? (agg.audioDelta/agg.cntAudioDelta).toFixed(1):'-', audioPlay: agg.cntAudioPlay? (agg.audioPlay/agg.cntAudioPlay).toFixed(1):'-' }; console.log('平均延迟(语音起点基准, ms):', avg); };


for(let i=0;i<48;i++){ const bar=document.createElement('div'); wave.appendChild(bar);} // simple visualizer bars

function handleConnectionClosed(msg){ if(isRecording) stopRecording(); webrtcActive=false; pc=null; dataChannel=null; sessionInfo=null; webrtcKey=null; activeResponse=false; if(remoteAudioEl){ try{remoteAudioEl.srcObject=null;}catch(_){} remoteAudioEl.remove(); remoteAudioEl=null; } connectBtn.disabled=false; disconnectBtn.disabled=true; micBtn.disabled=true; sendTextBtn.disabled=true; setStatus('已断开'); if(msg) log('sys',msg); }

// ---- Transcription (server events) ----
function handleTranscriptionDelta(target,payload){ const chunk = payload?.delta || payload?.text || payload?.value; if(!chunk) return; if(!target._modelTrPartial) target._modelTrPartial=''; target._modelTrPartial+=chunk; if(!target._modelTrDiv){ target._modelTrDiv=document.createElement('div'); target._modelTrDiv.className='msg'; target._modelTrDiv.innerHTML='<span class="role">模型转写:</span><span class="partial"></span>'; logEl.appendChild(target._modelTrDiv);} target._modelTrDiv.querySelector('.partial').textContent=target._modelTrPartial; logEl.scrollTop=logEl.scrollHeight; }
function handleTranscriptionCompleted(target,payload){ let finalText=target._modelTrPartial||''; const extra=payload?.text||payload?.transcript||''; if(!finalText && extra) finalText=extra; log('模型转写', finalText||'[完成]'); target._modelTrPartial=''; if(target._modelTrDiv){ target._modelTrDiv.remove(); target._modelTrDiv=null; } }

async function readJsonOrRaw(resp){ const text=await resp.text(); if(!text) return {}; try{ return JSON.parse(text); }catch(_){ return { raw:text }; } }

// ---- Session creation (supports mode param) ----
async function createSession(){
  const mode = connTypeSelect?.value === 'websocket' ? 'ws' : 'webrtc';
  const useGa = document.getElementById('useGaPath')?.checked;
  const selectedModel=getResolvedRealtimeModel();
  const url = '/api/realtime-session?mode='+mode + (useGa? '&use_v1=1':'&use_v1=0') + (selectedModel ? '&model='+encodeURIComponent(selectedModel) : '');
  const r=await fetch(url);
  const data=await readJsonOrRaw(r);
  if(!r.ok){ const short=data.error||data.raw||'unknown'; const hint=data.hint?(' HINT: '+data.hint):''; throw new Error(short+hint+' STATUS='+(data.status||r.status)); }
  try{
    if(data.resolved_session_endpoint){
      log('sys','session.resolved_endpoint='+data.resolved_session_endpoint+(data.use_v1_path_resolved?' (GA)':' (preview)'));
      if(data.path_variant){ log('sys','session.path_variant='+data.path_variant); }
    }
  }catch(_){ }
  // Pre-compute prospective WS URL for visibility
  setTimeout(()=>{ try{ const previewUrl=buildWebSocketUrl(); log('sys','预期 WebSocket URL -> '+previewUrl); }catch(e){ log('error','预计算 WS URL 失败: '+e.message); } },0);
  return data;
}

async function validateRealtimeAuth(){
  const r=await fetch('/api/realtime-auth-validation',{ cache:'no-store' });
  const detail=await readJsonOrRaw(r);
  if(!r.ok || detail?.ok===false){ const message=detail?.detail||detail?.error||detail?.raw||'unknown'; throw new Error(message); }
  if((detail?.auth_mode||'').toLowerCase()==='managed-identity') log('sys','managed identity 认证校验通过');
  return detail;
}

// Region inference (best-effort). Fallback eastus2.
function inferRegion(){ const ep=sessionInfo?.endpoint||''; const lower=(ep||'').toLowerCase(); if(/eastus2/.test(lower)) return 'eastus2'; if(/swedencentral/.test(lower)) return 'swedencentral'; if(/^eastus2$|^swedencentral$/.test(voiceInput.value.trim())) return voiceInput.value.trim(); return 'eastus2'; }

// ---- Audio playback of assistant PCM ----
function ensurePlayCtx(){ if(!audioPlayCtx){ audioPlayCtx=new (window.AudioContext||window.webkitAudioContext)({ sampleRate:AUDIO_SAMPLE_RATE }); audioPlayHead=audioPlayCtx.currentTime; } if(audioPlayCtx.state==='suspended'){ audioPlayCtx.resume().catch(()=>{});} }
function playBase64Pcm(b64){ if(!b64) return; ensurePlayCtx(); try{ const raw=atob(b64); const bytes=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i); const samples=new Int16Array(bytes.buffer); const f32=new Float32Array(samples.length); for(let i=0;i<samples.length;i++) f32[i]=samples[i]/32768; const buf=audioPlayCtx.createBuffer(1,f32.length,AUDIO_SAMPLE_RATE); buf.copyToChannel(f32,0,0); const src=audioPlayCtx.createBufferSource(); src.buffer=buf; const startAt=Math.max(audioPlayCtx.currentTime,audioPlayHead); src.connect(audioPlayCtx.destination); src.start(startAt); audioPlayHead=startAt+buf.duration; markLatency('audioPlay'); }catch(err){ console.warn('音频播放失败',err.message);} }
function showOrUpdateAudioTranscript(text){ if(!_audioTranscriptDivPartial){ _audioTranscriptDivPartial=document.createElement('div'); _audioTranscriptDivPartial.className='msg'; _audioTranscriptDivPartial.innerHTML='<span class="role">助理(语音中):</span><span class="partial"></span>'; logEl.appendChild(_audioTranscriptDivPartial);} _audioTranscriptDivPartial.querySelector('.partial').textContent=text; logEl.scrollTop=logEl.scrollHeight; }
function removeAudioTranscriptPartialDiv(){ if(_audioTranscriptDivPartial){ _audioTranscriptDivPartial.remove(); _audioTranscriptDivPartial=null; } }

// ---- Start (connect) ----
async function start(){ try{ const connType=connTypeSelect?.value||'webrtc'; if(connType==='websocket' && isManagedIdentityMode()){ log('error','当前为 managed identity 模式，WebSocket 直连调试不可用；请改用 WebRTC 或切回 API key 模式'); setStatus('创建失败'); return; } await validateRealtimeAuth(); sessionInfo=await createSession(); log('sys','会话创建成功'); if(connType==='websocket' && (sessionInfo?.auth_mode_resolved||'').toLowerCase()==='managed-identity'){ log('error','当前 session 使用 managed identity，WebSocket 直连调试不可用；请改用 WebRTC'); setStatus('创建失败'); return; } if(connType==='webrtc'){ if(!sessionInfo?.client_secret?.value){ log('error','缺少 WebRTC 临时密钥'); return; } await startWebRTC(); } else { await startWebSocket(); } }catch(e){ log('error','创建会话失败: '+e.message); setStatus('创建失败'); } }

// ---- WebSocket path builder (Azure OpenAI) ----
let wsPreviewLock=false; // 自动回退后锁定 preview；若用户重新勾选 GA 则解除
function buildWebSocketUrl(){
  let base = (sessionInfo?.endpoint||'').replace(/\/$/,'');
  if(!base){
    const cfgEp = window._cfg?.endpoint || '';
    if(cfgEp){ base = cfgEp.replace(/\/$/,''); log('sys','使用 fallback endpoint 构建 WebSocket URL'); }
  }
  if(!base){ log('error','仍缺少 endpoint, 无法构建 WebSocket URL'); return ''; }
  base = base.replace(/^http:/,'wss:').replace(/^https:/,'wss:');
  const deployment = getResolvedRealtimeModel();
  if(!deployment){ log('error','缺少 deployment/model，无法构建 WebSocket URL'); return ''; }
  const apiVersion = (sessionInfo?.api_version || sessionInfo?.apiVersion || '2025-04-01-preview').trim();
  const gaCheckbox = document.getElementById('useGaPath');
  const wantGa = gaCheckbox?.checked && (!wsPreviewLock || gaCheckbox.checked); // 勾选 GA 时即使锁定也强制 GA
  if(wantGa){
    return base + '/openai/v1/realtime?model=' + encodeURIComponent(deployment);
  }
  return base + '/openai/realtime?api-version=' + encodeURIComponent(apiVersion) + '&deployment=' + encodeURIComponent(deployment);
}

let ws=null; let wsActive=false; let wsFirstMessageTimer=null; let wsConnectedAt=0; let wsReceivedAny=false; let wsUrlLast=''; let secondarySessionUpdateSent=false;
window.__wsRef=()=>ws; // 简单全局引用供调试
// Raw frame & event debug toggles
let rawFrameDebug=false; // 默认关闭，可在控制台设 window.__rawFrameDebug=true 打开
Object.defineProperty(window,'__rawFrameDebug',{ get(){ return rawFrameDebug; }, set(v){ rawFrameDebug=!!v; console.log('[rawFrameDebug]',rawFrameDebug); }});
async function fetchWsKey(){
  try{ const r=await fetch('/api/realtime-ws-key',{ cache:'no-store' }); if(!r.ok) return null; const j=await r.json(); return j.api_key||null; }catch(_){ return null; }
}

function startWebSocket(){
  return new Promise(async (resolve,reject)=>{
    let url=buildWebSocketUrl(); wsUrlLast=url;
    if(!url){ reject(new Error('缺少 WebSocket 连接参数')); return; }
    const apiKey = await fetchWsKey();
    if(apiKey){
      url += (url.includes('?')?'&':'?') + 'api-key=' + encodeURIComponent(apiKey);
    } else {
      log('warn', isManagedIdentityMode() ? '当前 managed identity 模式不支持 WebSocket 直连调试，请优先使用 WebRTC。' : '未能获取 API Key，将尝试无鉴权连接(可能被服务器拒绝)');
    }
    log('sys','WebSocket 连接 -> '+url);
    try{
  ws=new WebSocket(url,['realtime']);
  // Outbound frame interceptor
  const _origSend=ws.send.bind(ws);
  ws.send=function(data){ try{ if(rawFrameDebug){ log('out', (typeof data==='string'? data.slice(0,800):'[binary]')); } }catch(_){ } return _origSend(data); };
      ws.addEventListener('open',()=>{ wsActive=true; wsConnectedAt=performance.now(); wsReceivedAny=false; activeConnType='websocket';
        log('diag','WS open url='+wsUrlLast+' path_variant='+ (sessionInfo?.path_variant)+' v1_resolved='+(sessionInfo?.use_v1_path_resolved)+' readyState='+ws.readyState);
        connectBtn.disabled=true; disconnectBtn.disabled=false; micBtn.disabled=false; sendTextBtn.disabled=false; setStatus('已连接(WebSocket)'); resolve();
    const initSession={ type:'session.update', session:{ type:'realtime', audio:{ input:{ format:{ type:'audio/pcm', rate:24000 } } } }}; // 包含 audio.input.format 以允许运行时追加 PCM
      const selectedModel=getResolvedRealtimeModel();
      if(selectedModel) initSession.session.model=selectedModel;
        try{ log('sys','初始最小 session.update: '+JSON.stringify(initSession)); }catch(_){ }
        ws.send(JSON.stringify(initSession));
        wsFirstMessageTimer=setTimeout(()=>{ if(!wsReceivedAny){ log('warn','GA WebSocket 无响应，尝试 preview 回退'); attemptWebSocketPreviewFallback(); } },800);
      });
      ws.addEventListener('message', handleWsMessage);
  ws.addEventListener('close', ev=>{ wsActive=false; if(wsFirstMessageTimer){ clearTimeout(wsFirstMessageTimer); wsFirstMessageTimer=null; } log('diag','WS close code='+ev.code+' reason='+(ev.reason||'')+' duration_ms='+(performance.now()-wsConnectedAt).toFixed(0)); log('error','WebSocket 已关闭 code='+ev.code+' reason='+(ev.reason||'')); handleConnectionClosed('WebSocket 已关闭'); });
      ws.addEventListener('error', ev=>{ log('error','WebSocket 错误'); });
    }catch(e){ reject(e); }
  });
}

function handleWsMessage(e){
  wsReceivedAny=true;
  if(wsFirstMessageTimer){ clearTimeout(wsFirstMessageTimer); wsFirstMessageTimer=null; }
  if(rawFrameDebug){ try{ log('in', (e.data||'').slice(0,800)); }catch(_){ } }
  let msg; try{ msg=JSON.parse(e.data); }catch(_){ log('raw',(e.data||'').slice(0,200)); return; }
  const type=msg.type||'';
  if(rawFrameDebug) log('evt', type||'[no-type]');
  switch(type){
    case 'session.updated':
      scheduleSecondarySessionUpdate();
      break;
    case 'response.created':
      activeResponseId = msg.response?.id || null;
      activeResponse=true;
      responseCreatedAt=performance.now();
      if(verboseDebug) log('diag','response.created id='+activeResponseId);
      break;
    case 'response.output_text.delta': // textual delta (if any)
      markLatency('text');
      if(!ws._partial) ws._partial='';
      ws._partial+=msg.delta;
      if(!ws._partialDiv){
        ws._partialDiv=document.createElement('div');
        ws._partialDiv.className='msg';
        ws._partialDiv.innerHTML='<span class="role">助理:</span><span class="partial"></span>';
        logEl.appendChild(ws._partialDiv);
      }
      ws._partialDiv.querySelector('.partial').textContent=ws._partial;
      break;
    case 'response.output_audio_transcript.delta': // streaming transcript text
      if(typeof msg.delta==='string'){ audioTranscriptPartial+=msg.delta; showOrUpdateAudioTranscript(audioTranscriptPartial); markLatency('text'); }
      break;
    case 'response.output_audio_transcript.done':
      if(msg.transcript){
        audioTranscriptPartial=msg.transcript; // ensure full
        log('assistant', audioTranscriptPartial);
        removeAudioTranscriptPartialDiv();
        audioTranscriptPartial='';
      }
      break;
    case 'response.output_audio.delta': // PCM audio chunks (base64)
      markLatency('audioDelta');
      playBase64Pcm(msg.delta);
      assistantAudioStreaming=true;
      break;
    case 'response.content_part.added':
      // ignore structural for now
      break;
    case 'response.output_item.done':
      // final item collected
      break;
    case 'response.done':
      if(ws._partial){ log('assistant', ws._partial); }
      ws._partial=''; ws._partialDiv=null; activeResponse=false; emitLatencyMetrics(true);
      assistantAudioStreaming=false;
      activeResponseId=null;
      cancelInFlight=false;
      responseCreatedAt=0;
      break;
    case 'response.cancelled':
      log('warn','响应已取消');
      activeResponse=false; activeResponseId=null; ws._partial=''; ws._partialDiv=null; removeAudioTranscriptPartialDiv();
      assistantAudioStreaming=false;
      cancelInFlight=false;
      responseCreatedAt=0;
      break;
    case 'error':
      log('error', msg.error||msg);
      break;
    default:
      if(/transcription\.delta$/.test(type)){ handleTranscriptionDelta(ws,msg); }
      else if(/transcription\.completed$/.test(type)){ handleTranscriptionCompleted(ws,msg); }
      break;
  }
}

function scheduleSecondarySessionUpdate(){ if(secondarySessionUpdateSent) return; secondarySessionUpdateSent=true; setTimeout(()=>{ if(!wsActive || ws?.readyState!==WebSocket.OPEN) return; const sp=systemPromptInput?.value?.trim(); const payload={ type:'session.update', session:{ type:'realtime' } }; if(sp){ payload.session.instructions=sp; } const isAzure = /\.azure\.com/i.test(sessionInfo?.endpoint||''); const currentUrl=wsUrlLast||''; const isGaWs=/\/openai\/v1\/realtime/.test(currentUrl);
  // 需求：GA (v1) 模式下发送 MCP 工具以测试；preview 下仍抑制
  if(isAzure){
    if(isGaWs){ const mcpTools=buildMcpToolsPayload(); if(mcpTools){ payload.session.tools=mcpTools; log('sys','GA + MCP tools 发送'); } else { payload.session.tools=[]; } }
    else { payload.session.tools=[]; log('sys','Preview 抑制 MCP tools'); }
  } else { const mcpTools=buildMcpToolsPayload(); if(mcpTools){ payload.session.tools=mcpTools; } else { payload.session.tools=[]; } }
  try{ log('sys','二次 session.update (扩展) : '+JSON.stringify(payload)); }catch(_){ } ws.send(JSON.stringify(payload)); },50); }

function attemptWebSocketPreviewFallback(){
  if(!sessionInfo) return;
  if(wsPreviewLock) return; // 已回退
  // 若用户勾选 GA 且明确想强制 GA，不立即回退（除非显式快速失败），这里仍使用原逻辑
  if(document.getElementById('useGaPath')?.checked){ log('warn','用户已强制 GA，跳过自动 preview 回退'); return; }
  wsPreviewLock=true;
  sessionInfo.path_variant='preview-fallback-client';
  sessionInfo.use_v1_path_resolved=false;
  if(ws && ws.readyState===WebSocket.OPEN){ try{ ws.close(4000,'client-fallback'); }catch(_){ } }
  setTimeout(()=>{ log('sys','发起 preview WebSocket 回退重连'); startWebSocket().catch(e=>log('error','回退重连失败: '+e.message)); },100);
}

// 监听 GA 复选框，用户重新勾选则解除 preview 锁并提示需要重连
document.getElementById('useGaPath')?.addEventListener('change', e=>{
  const cb=e.target; if(cb.checked){ if(wsPreviewLock){ wsPreviewLock=false; log('sys','GA 勾选 -> 解除 preview 锁，下次连接将使用 GA'); } if(wsActive){ log('sys','请断开并重新连接以切换到 GA WebSocket'); } }
});

// (统一版本) 文本发送，自动检测当前连接类型
function sendTextUnified(){
  const txt=textInput.value.trim();
  if(!txt) return;
  const usingWs = (activeConnType==='websocket');
  // 统一延迟回合逻辑
  if(!latencyCurrentTurn || latencyCurrentTurn.metricsEmitted){ startLatencyTurn(); latencyCurrentTurn.tVoiceStartDetected = latencyCurrentTurn.tMicStart; }
  if(usingWs){
    if(!wsActive || ws?.readyState!==WebSocket.OPEN){ log('error','WebSocket 未连接'); return; }
    ws.send(JSON.stringify({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text:txt }] } }));
    if(!activeResponse){
      sendAdaptiveResponseCreate('ws');
    } else { log('sys','已有活动响应，跳过新的 response.create'); }
    log('user', txt); textInput.value='';
    return;
  }
  // WebRTC 路径
  if(!webrtcActive || dataChannel?.readyState!=='open'){ log('error','未连接'); return; }
  dataChannel.send(JSON.stringify({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text:txt }] } }));
  if(!activeResponse){ sendAdaptiveResponseCreate('webrtc'); } else { log('sys','已有活动响应，跳过新的 response.create'); }
  log('user', txt); textInput.value='';
}
// 统一导出
window.sendText = sendTextUnified;

// 自适应 response.create 组装（根据当前路径 / 过去错误来决定最小或扩展形式）
let lastResponseCreateStyle='minimal';
function sendAdaptiveResponseCreate(kind){
  const isWs = kind==='ws';
  const target = isWs? ws : dataChannel;
  if(!target) return;
  const startTs=performance.now();
  const variants=[
    { style:'minimal', payload:{ type:'response.create', response:{} } },
    { style:'withEmptyInstructions', payload:{ type:'response.create', response:{ instructions:'' } } },
    { style:'withMetadata', payload:{ type:'response.create', response:{ metadata:{ client_probe: true } } } },
    { style:'forceRetryMinimal', payload:{ type:'response.create', response:{} } },
  ];
  let idx=0;
  function sendNext(){
    if(idx>=variants.length){ log('error','已发送所有探针变体仍无响应'); return; }
    const v=variants[idx++];
    try{ target.send(JSON.stringify(v.payload)); activeResponse=true; lastResponseCreateStyle=v.style; log('sys','发送 response.create 变体 style='+v.style); }
    catch(e){ log('error','发送 response.create('+v.style+') 失败: '+e.message); return; }
    scheduleCheck(v.style);
  }
  function scheduleCheck(style){
    setTimeout(()=>{
      if(!activeResponse || wsReceivedAny || (ws && ws._partial)) return; // 已有输出或响应完成
      log('warn','response.create style='+style+' 超时无响应，尝试下一个变体');
      // 如果 session 中带 tools 可能被阻塞，尝试一次移除 tools
      if(style==='withMetadata' && sessionInfo){
        try{
          if(ws && ws.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({ type:'session.update', session:{ type:'realtime', tools:[] }})); log('warn','探针：移除 tools 再次尝试'); }
        }catch(_){ }
      }
      sendNext();
    }, style==='minimal'?1200: (style==='withEmptyInstructions'?1400:1600));
  }
  sendNext();
}

window.__dumpConn=()=>{ try{ const snap={ wsActive, wsReady: ws? ws.readyState:undefined, activeConnType, hasPartial: !!(ws&&ws._partial), receivedAny: wsReceivedAny, lastResponseCreateStyle, dcState: dataChannel?.readyState }; console.log('[conn]',snap); log('diag','snapshot '+JSON.stringify(snap)); }catch(e){ console.log(e); } };

function disconnect(){ if(dataChannel && dataChannel.readyState!=='closed'){ try{ dataChannel.close(); }catch(_){} } if(pc && pc.signalingState!=='closed'){ try{ pc.close(); }catch(_){} } handleConnectionClosed('已断开'); }

async function startWebRTC(){ webrtcKey=sessionInfo.client_secret.value; const selectedModel=getResolvedRealtimeModel(); if(!selectedModel){ log('error','缺少 deployment/model，无法发起 WebRTC'); return; } const region=inferRegion(); const rtcUrl=`https://${region}.realtimeapi.ai.azure.com/v1/realtimertc?model=${encodeURIComponent(selectedModel)}`; log('sys','WebRTC offer -> '+rtcUrl); pc=new RTCPeerConnection(); remoteAudioEl=document.createElement('audio'); remoteAudioEl.autoplay=true; document.body.appendChild(remoteAudioEl); pc.ontrack=ev=>{ remoteAudioEl.srcObject=ev.streams[0]; const tracks=ev.streams[0].getAudioTracks(); if(tracks&&tracks[0]){ const track=tracks[0]; track.onunmute=()=>{ if(latencyCurrentTurn && !latencyCurrentTurn.tFirstAudioPlay){ markLatency('audioPlay'); } }; } };
  dataChannel=pc.createDataChannel('realtime'); dataChannel.addEventListener('open',()=>{ log('sys','DataChannel 打开'); webrtcActive=true; activeConnType='webrtc'; activeResponse=false; connectBtn.disabled=true; disconnectBtn.disabled=false; micBtn.disabled=false; sendTextBtn.disabled=false; setStatus('已连接(WebRTC)'); const tempVal=safeNumber(tempInput.value, DEFAULT_TEMPERATURE); if(tempVal!==safeNumber(tempInput.dataset._lastSent,undefined)) tempInput.dataset._lastSent=tempVal; const maxTokRaw=maxTokensInput.value; const maxTok=Number.isFinite(Number(maxTokRaw)) && maxTokRaw!==''? parseInt(maxTokRaw,10): undefined; const sessionObj={ type:'realtime' }; if(selectedModel) sessionObj.model=selectedModel; if(maxTok) sessionObj.max_response_output_tokens=maxTok; const init={ type:'session.update', session: sessionObj }; const sp=systemPromptInput?.value?.trim(); if(sp){ init.session.instructions=sp; log('sys','应用系统Prompt: '+ (sp.length>80? sp.slice(0,77)+'...':sp)); } else { log('sys','未提供系统Prompt(使用服务器初始或空)'); }
  // turn_detection 已被 Azure Realtime 当前路径报告 unknown_parameter，暂不发送该配置。
  const mcpTools=buildMcpToolsPayload(); if(mcpTools){ init.session.tools=mcpTools; if(mcpTools.length){ const label=mcpTools[0].server_label||mcpTools[0].server_url; log('sys','MCP 工具已启用: '+label); } else { log('sys','MCP 工具已禁用'); } }
  else { init.session.tools=[]; log('sys','MCP 工具未配置'); }
  applyTranscriptionPreference(init.session,{ forceNullWhenDisabled:true });
  try{ log('sys','session.update payload: '+JSON.stringify(init)); }catch(_){ log('sys','session.update payload: [无法序列化]'); }
  dataChannel.send(JSON.stringify(init)); if(wantServerTurn) log('sys','服务器断句已启用(默认)'); if(document.getElementById('enableLatencyLog')?.checked) log('lat','(WebRTC) 音频通过 RTP 轨道传输, 不会出现 response.audio.delta 事件'); }); dataChannel.addEventListener('message', onDataChannelMessage); dataChannel.addEventListener('close', ()=> handleConnectionClosed('DataChannel 已关闭')); try{ audioStream=await navigator.mediaDevices.getUserMedia({ audio:true }); audioStream.getAudioTracks().forEach(t=>pc.addTrack(t,audioStream)); }catch(e){ log('error','麦克风失败: '+e.message); }
  const offer=await pc.createOffer(); await pc.setLocalDescription(offer); const resp=await fetch(rtcUrl,{ method:'POST', body: offer.sdp, headers:{ 'Authorization':`Bearer ${webrtcKey}`, 'Content-Type':'application/sdp' } }); if(!resp.ok){ log('error','WebRTC offer 失败: '+resp.status); return; } const answer=await resp.text(); await pc.setRemoteDescription({ type:'answer', sdp:answer }); }

function onDataChannelMessage(e){ try{ const msg=JSON.parse(e.data); const type=msg.type||''; if(type==='response.output_text.delta'){ markLatency('text'); if(!dataChannel._partial) dataChannel._partial=''; dataChannel._partial+=msg.delta; if(!dataChannel._partialDiv){ dataChannel._partialDiv=document.createElement('div'); dataChannel._partialDiv.className='msg'; dataChannel._partialDiv.innerHTML='<span class="role">助理:</span><span class="partial"></span>'; logEl.appendChild(dataChannel._partialDiv);} dataChannel._partialDiv.querySelector('.partial').textContent=dataChannel._partial; }
  else if(type==='response.created'){ activeResponseId=msg.response?.id||null; activeResponse=true; if(verboseDebug) log('diag','response.created id='+activeResponseId); }
  else if(type==='response.completed'){ log('assistant', dataChannel._partial||'[完成]'); dataChannel._partial=''; dataChannel._partialDiv=null; activeResponse=false; emitLatencyMetrics(true); }
  else if(type==='response.audio.delta'){ markLatency('audioDelta'); playBase64Pcm(msg.delta); }
  else if(type==='response.audio.delta'){ assistantAudioStreaming=true; }
  else if(type==='response.audio_transcript.delta'){ if(typeof msg.delta==='string'){ audioTranscriptPartial+=msg.delta; showOrUpdateAudioTranscript(audioTranscriptPartial);} }
  else if(type==='response.audio_transcript.done'){ if(msg.transcript && !audioTranscriptPartial.endsWith(msg.transcript)) audioTranscriptPartial+=msg.transcript; if(audioTranscriptPartial){ log('助理(语音转写)', audioTranscriptPartial); audioTranscriptPartial=''; removeAudioTranscriptPartialDiv(); } }
  else if(type==='response.done'){ activeResponse=false; emitLatencyMetrics(true); }
  else if(type==='response.done'){ assistantAudioStreaming=false; activeResponseId=null; }
  else if(type==='response.done'){ cancelInFlight=false; }
  else if(type==='response.cancelled'){ log('warn','响应已取消'); activeResponse=false; activeResponseId=null; dataChannel._partial=''; dataChannel._partialDiv=null; removeAudioTranscriptPartialDiv(); }
  else if(/transcription\.delta$/.test(type)){ handleTranscriptionDelta(dataChannel,msg); }
  else if(/transcription\.completed$/.test(type)){ handleTranscriptionCompleted(dataChannel,msg); }
  else if(type==='error'){ log('error', msg.error||msg); }
}catch(err){ log('raw', e.data.slice(0,200)); } }

// ---- Mic handling (WebRTC already sending track) ----
async function toggleMic(){ if(isRecording){ stopRecording(); return; } if(!audioStream){ audioStream=await navigator.mediaDevices.getUserMedia({ audio:true }); if(pc){ audioStream.getAudioTracks().forEach(t=>pc.addTrack(t,audioStream)); } } // simple local RMS visualizer
  try{ audioCtxVis = audioCtxVis || new (window.AudioContext||window.webkitAudioContext)(); const src=audioCtxVis.createMediaStreamSource(audioStream); analyser=audioCtxVis.createAnalyser(); analyser.fftSize=256; src.connect(analyser); visualize(); }catch(_){ }
  if(enableLocalStt.checked) startLocalSTT(); isRecording=true; micBtn.textContent='停止说话'; log('sys','麦克风已开启'); startLatencyTurn(); }
function stopRecording(){ if(audioStream){ audioStream.getTracks().forEach(t=>t.stop()); audioStream=null; } cancelAnimationFrame(rafId); if(sttActive) stopLocalSTT(); isRecording=false; micBtn.textContent='开始说话'; Array.from(wave.children).forEach(c=>{ c.style.height='4px'; c.classList.remove('active'); }); log('sys','麦克风已关闭'); }

// ---- Text send ----
// 兼容旧函数名（仍可能被外部脚本调用）
function sendText(){ return sendTextUnified(); }

// ---- Session Update ----
function buildTranscriptionPreference(){ return null; }
function applyTranscriptionPreference(target,{forceNullWhenDisabled}={}){ if(forceNullWhenDisabled){ /* no-op: 不发送该字段 */ } }
function sendSessionUpdate(){ if(!webrtcActive||dataChannel?.readyState!=='open') return; const tempVal=safeNumber(tempInput.value, DEFAULT_TEMPERATURE); const maxTokRaw=maxTokensInput.value; const maxTok=Number.isFinite(Number(maxTokRaw)) && maxTokRaw!==''? parseInt(maxTokRaw,10): undefined; const sessionObj={ type:'realtime' }; const selectedModel=getResolvedRealtimeModel(); if(selectedModel) sessionObj.model=selectedModel; if(maxTok) sessionObj.max_response_output_tokens=maxTok; const payload={ type:'session.update', session: sessionObj }; const sp=systemPromptInput?.value?.trim(); if(sp){ payload.session.instructions=sp; } else if(systemPromptInput){ payload.session.instructions=''; }
  // turn_detection 暂不发送，避免 unknown_parameter 错误。
  const mcpTools=buildMcpToolsPayload(); if(mcpTools){ payload.session.tools=mcpTools; if(mcpTools.length){ const label=mcpTools[0].server_label||mcpTools[0].server_url; log('sys','MCP 工具已启用: '+label); } else { log('sys','MCP 工具已禁用'); } }
  else { payload.session.tools=[]; log('sys','MCP 工具未配置'); }
  applyTranscriptionPreference(payload.session,{ forceNullWhenDisabled:true });
  try{ log('sys','session.update payload: '+JSON.stringify(payload)); }catch(_){ log('sys','session.update payload: [无法序列化]'); }
  dataChannel.send(JSON.stringify(payload)); log('sys','已更新会话'); if(sp) log('sys','已更新系统Prompt'); if(!sp && systemPromptInput && systemPromptInput.value.trim()==='') log('sys','系统Prompt已清空'); if(wantServerTurn) log('sys','服务器断句启用'); if(payload.session.input_audio_transcription) log('sys','服务器转写启用'); }

[modelInput,tempInput,maxTokensInput,voiceInput,systemPromptInput].forEach(el=> el && el.addEventListener('change',()=>sendSessionUpdate()));
[enableServerTurnInput,serverTurnThresholdInput,serverTurnSilenceMsInput].forEach(el=> el.addEventListener('change',()=>sendSessionUpdate()));

// ---- Local STT (Web Speech) ----
function startLocalSTT(){ const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){ log('error','浏览器不支持本地 STT'); return; } recognition=new SR(); recognition.lang='zh-CN'; recognition.continuous=true; recognition.interimResults=true; recognition.onstart=()=>{ sttActive=true; log('sys','本地转写启动'); }; recognition.onerror=e=>log('error','STT: '+e.error); recognition.onend=()=>{ sttActive=false; log('sys','本地转写结束'); if(isRecording && enableLocalStt.checked){ try{ recognition.start(); }catch(_){ } } }; recognition.onresult=(ev)=>{ let final=''; let interim=''; for(let i=ev.resultIndex;i<ev.results.length;i++){ const r=ev.results[i]; if(r.isFinal) final+=r[0].transcript; else interim+=r[0].transcript; } if(interim){ if(!recognition._interimDiv){ recognition._interimDiv=document.createElement('div'); recognition._interimDiv.className='msg'; recognition._interimDiv.innerHTML='<span class="role">转写:</span><span class="partial"></span>'; logEl.appendChild(recognition._interimDiv);} recognition._interimDiv.querySelector('.partial').textContent=interim; } if(final){ log('转写',final.trim()); if(recognition._interimDiv){ recognition._interimDiv.remove(); recognition._interimDiv=null; } if(autoSendStt.checked){ textInput.value=final.trim(); sendText(); } } }; try{ recognition.start(); }catch(_){ } }
function stopLocalSTT(){ if(recognition){ try{ recognition.stop(); }catch(_){} } recognition=null; sttActive=false; }

// ---- Visualizer ----
function visualize(){
  if(!analyser) return;
  const bufferLength=analyser.frequencyBinCount;
  const dataArray=new Uint8Array(bufferLength);
  const bars=wave.children;
  function draw(){
    rafId=requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    for(let i=0;i<bars.length;i++){
      const v=dataArray[i%bufferLength];
      const h=Math.max(4,(v/255)*120);
      const el=bars[i];
      el.style.height=h+'px';
      el.classList.toggle('active', v>30);
    }
    // 计算时域 RMS
    let rms=0; if(analyser){
      const tdSize=analyser.fftSize || 2048;
      const timeDomain=new Uint8Array(tdSize);
      try{ analyser.getByteTimeDomainData(timeDomain); }catch(_){ }
      let sumSq=0; for(let i=0;i<timeDomain.length;i++){ const s=(timeDomain[i]-128)/128; sumSq+=s*s; }
      rms=Math.sqrt(sumSq/timeDomain.length);
    }
    const vadActive = rms>vadRmsThreshold;
    if(isRecording && vadActive){
      if(latencyCurrentTurn && latencyCurrentTurn.metricsEmitted){ startLatencyTurn(); }
      ensureLatencyVoiceStart();
      silenceFrameCount=0;
      consecutiveVoiceFrames++;
      const earlyWindowMs = 2500; // 在响应创建后允许提前打断的时间窗口
      const sinceCreated = responseCreatedAt? (performance.now()-responseCreatedAt): Infinity;
      const canInterruptEarly = sinceCreated <= earlyWindowMs;
      const streamingOrEarly = assistantAudioStreaming || canInterruptEarly; // 允许音频尚未开始时插话
      if(autoInterruptEnabled && streamingOrEarly && activeResponseId && !cancelInFlight){
        if(consecutiveVoiceFrames>=autoInterruptConsecFrames){
          if(verboseDebug) log('diag',`VAD触发: 连续${consecutiveVoiceFrames}帧 (rms=${rms.toFixed(3)} 阈=${vadRmsThreshold}) 响应创建于 ${sinceCreated.toFixed(0)}ms 前 -> 取消`);
          cancelActiveResponse();
          cancelInFlight=true;
          assistantAudioStreaming=false;
          consecutiveVoiceFrames=0;
          if(!interjectionActive){
            interjectionActive=true;
            performInterject();
            setTimeout(()=>{ interjectionActive=false; },800);
          }
        }
      }
    } else if(isRecording){
      silenceFrameCount++;
      if(silenceFrameCount>=vadMinSilenceFrames){
        if(consecutiveVoiceFrames!==0) consecutiveVoiceFrames=0;
      }
    }
  }
  draw();
}

// =========================
// WebSocket Mic Streaming
// =========================
// 当活动连接类型为 websocket 时，采集麦克风并将 16bit PCM(24kHz) base64 分块通过 input_audio_buffer.append 事件发送；
// 结束时发送 input_audio_buffer.commit 再触发 response.create。
let wsAudioCtx=null; let wsAudioProc=null; let wsAudioBuffer=[]; // accumulate Int16Array chunks
const WS_STREAM_TARGET_RATE=24000; const WS_STREAM_CHUNK_MS=200; // approx per chunk
let wsTotalSamples=0; // 累计已发送的样本数（用于判定最小长度）

function startWsMicStreaming(){
  if(activeConnType!=='websocket' || !wsActive || ws?.readyState!==WebSocket.OPEN) return;
  if(wsAudioProc){ return; }
  try{
    wsAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const src = wsAudioCtx.createMediaStreamSource(audioStream);
    const processor = wsAudioCtx.createScriptProcessor(2048,1,1);
    let lastEmit=performance.now();
    processor.onaudioprocess = ev => {
      const input = ev.inputBuffer.getChannelData(0);
      // Resample to 24kHz if needed
      const inRate = wsAudioCtx.sampleRate;
      let resampled = input;
      if(inRate !== WS_STREAM_TARGET_RATE){
        const ratio = inRate / WS_STREAM_TARGET_RATE;
        const newLen = Math.round(input.length / ratio);
        const tmp = new Float32Array(newLen);
        for(let i=0;i<newLen;i++){ const idx=i*ratio; const i0=Math.floor(idx); const i1=Math.min(i0+1,input.length-1); const frac=idx-i0; tmp[i]= input[i0]*(1-frac)+input[i1]*frac; }
        resampled = tmp;
      }
      // Float32 -> Int16
      const pcm16 = new Int16Array(resampled.length);
      for(let i=0;i<resampled.length;i++){ let s=resampled[i]; if(s>1)s=1; else if(s<-1)s=-1; pcm16[i]= s<0? s*0x8000 : s*0x7FFF; }
      wsAudioBuffer.push(pcm16);
  wsTotalSamples += pcm16.length;
      const now=performance.now();
      if(now - lastEmit >= WS_STREAM_CHUNK_MS){
        flushWsAudioChunk();
        lastEmit=now;
      }
    };
    src.connect(processor); processor.connect(wsAudioCtx.destination);
    wsAudioProc = processor;
    log('sys','WebSocket 音频推流启动');
  }catch(err){ log('error','启动 WS 音频推流失败: '+err.message); }
}

function flushWsAudioChunk(){
  if(!wsAudioBuffer.length) return;
  let total=0; wsAudioBuffer.forEach(b=> total+=b.length);
  const merged = new Int16Array(total); let off=0; wsAudioBuffer.forEach(b=>{ merged.set(b,off); off+=b.length; }); wsAudioBuffer=[];
  const bytes = new Uint8Array(merged.buffer);
  let binary=''; for(let i=0;i<bytes.length;i++){ binary+=String.fromCharCode(bytes[i]); }
  const b64 = btoa(binary);
  try{ ws.send(JSON.stringify({ type:'input_audio_buffer.append', audio: b64 })); if(verboseDebug) log('out','[audio_chunk '+merged.length+' samples]'); }catch(err){ log('error','发送音频块失败: '+err.message); }
}

function stopWsMicStreaming(commit=true){
  try{ if(wsAudioProc){ wsAudioProc.disconnect(); wsAudioProc.onaudioprocess=null; } if(wsAudioCtx){ wsAudioCtx.close().catch(()=>{}); } }catch(_){ }
  wsAudioProc=null; wsAudioCtx=null;
  flushWsAudioChunk();
  if(commit && activeConnType==='websocket' && wsActive && ws?.readyState===WebSocket.OPEN){
    const ms = wsTotalSamples / WS_STREAM_TARGET_RATE * 1000;
    if(ms < 120){
      log('warn',`音频过短(${ms.toFixed(0)}ms) 跳过提交与推理`);
    } else {
      try{ ws.send(JSON.stringify({ type:'input_audio_buffer.commit' })); log('sys','WS 音频提交'); }catch(err){ log('error','提交音频失败: '+err.message); }
      try{ ws.send(JSON.stringify({ type:'response.create', response:{} })); activeResponse=true; lastResponseCreateStyle='minimal'; log('sys','发送 response.create (音频会话)'); }catch(err){ log('error','发送 response.create 失败: '+err.message); }
    }
  }
  wsTotalSamples=0;
}

// Hook mic start/stop for WS mode
const _origToggleMic = toggleMic;
// 重写 toggleMic 以在 websocket 模式启动 / 停止推流
toggleMic = async function(){
  if(isRecording){
    if(activeConnType==='websocket'){ stopWsMicStreaming(true); }
    return _origToggleMic();
  }
  await _origToggleMic();
  if(isRecording && activeConnType==='websocket'){
    // Azure 不支持 input_audio_buffer.start，直接开始 append
    startWsMicStreaming();
  }
};

// =========================
// Response Cancellation
// =========================
function stopAllScheduledAudio(){ if(audioPlayCtx){ try{ audioPlayCtx.close(); }catch(_){ } audioPlayCtx=null; audioPlayHead=0; } }
function cancelActiveResponse(){
  if(!activeResponseId){ log('warn','当前无进行中的响应'); return; }
  if(cancelInFlight){ if(verboseDebug) log('diag','取消进行中，忽略重复'); return; }
  const payload={ type:'response.cancel', response_id: activeResponseId };
  try{
    if(activeConnType==='websocket' && wsActive && ws?.readyState===WebSocket.OPEN){ ws.send(JSON.stringify(payload)); }
    else if(activeConnType==='webrtc' && webrtcActive && dataChannel?.readyState==='open'){ dataChannel.send(JSON.stringify(payload)); }
    log('sys','发送 response.cancel id='+activeResponseId);
    cancelInFlight=true;
  }catch(err){ log('error','发送取消失败: '+err.message); }
  stopAllScheduledAudio();
}
window.cancelResponse = cancelActiveResponse;
window.getActiveResponseId = ()=>activeResponseId;
// 绑定可选按钮（如果页面存在 id=cancelRespBtn）
document.getElementById('cancelRespBtn')?.addEventListener('click', cancelActiveResponse);

// 插话：取消后立即创建一个新的用户轮次（可带当前本地 STT 的临时文本，如果有）以便后续音频或文本继续
function performInterject(){
  let interimText='';
  try{ if(recognition && recognition._interimDiv){ interimText = recognition._interimDiv.querySelector('.partial')?.textContent?.trim() || ''; } }catch(_){ }
  const contentText = interimText ? `（插话）${interimText}` : '（插话开始）';
  const itemPayload={ type:'message', role:'user', content:[{ type:'input_text', text: contentText }] };
  try{
    if(activeConnType==='websocket' && wsActive && ws?.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({ type:'conversation.item.create', item: itemPayload })); }
    else if(activeConnType==='webrtc' && webrtcActive && dataChannel?.readyState==='open'){ dataChannel.send(JSON.stringify({ type:'conversation.item.create', item: itemPayload })); }
    log('user', contentText);
  }catch(err){ log('error','插话发送失败: '+err.message); }
}
window.__performInterject = performInterject;

// ---- Events ----
textInput.addEventListener('keydown',e=>{ if(e.key==='Enter' && (e.metaKey||e.ctrlKey)) sendTextUnified(); });
connectBtn.addEventListener('click', start); disconnectBtn.addEventListener('click', disconnect); micBtn.addEventListener('click', toggleMic); sendTextBtn.addEventListener('click', sendTextUnified);

// ---- Diagnostics ----
Object.defineProperty(window,'rtConn',{ get(){ return { dataChannel, webrtcActive }; }});
window.sendDiagText=function(t,{wantAudio=false}={}){ if(!t) return; if(!webrtcActive||dataChannel?.readyState!=='open') return; dataChannel.send(JSON.stringify({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text:t }] } })); const respCreate={ type:'response.create', response:{} }; dataChannel.send(JSON.stringify(respCreate)); };
window.sendDiagPing=function(){ if(!webrtcActive||dataChannel?.readyState!=='open') return; dataChannel.send(JSON.stringify({ type:'session.update', session:{} })); };
window.printRtState=function(){ console.log('webrtcActive=',webrtcActive,'dcState=',dataChannel?.readyState,'partial=',dataChannel?._partial); };
window.checkLocalSTT=function(){ const SR=window.SpeechRecognition||window.webkitSpeechRecognition; log('sys', SR? '本地 STT 可用':'本地 STT 不可用'); };

// Expose for console experimentation
window.__WEbrtcAppVersion='webrtc-only-v1';

// =========================
// 延迟面板逻辑
// =========================
const latPanel=document.getElementById('latencyPanel');
const latAvgText=document.getElementById('latAvgText');
const latAvgAudioDelta=document.getElementById('latAvgAudioDelta');
const latAvgAudioPlay=document.getElementById('latAvgAudioPlay');
const latCurrentTurn=document.getElementById('latCurrentTurn');
const latHistoryDiv=document.getElementById('latHistory');
const btnLatToggle=document.getElementById('btnLatToggle');
const btnLatShow=document.getElementById('btnLatShow');
const btnLatExport=document.getElementById('btnLatExport');
const btnLatClear=document.getElementById('btnLatClear');
const btnLatPin=document.getElementById('btnLatPin');
const chkShowLatency=document.getElementById('showLatencyPanel');
let latPinned=false;

// 重写 emitLatencyMetrics 以便在原有逻辑后刷新UI
const _emitLatencyMetricsOrig = emitLatencyMetrics;
emitLatencyMetrics = function(force){
  const beforeLen=latencyHistory.length; _emitLatencyMetricsOrig(force);
  if(latencyHistory.length!==beforeLen){
    // 刚刚新增一条
    const last=latencyHistory[latencyHistory.length-1];
    appendLatencyRow(last);
    refreshLatencySummary();
  } else {
    refreshLatencySummary();
  }
};

function fmt(v){ return v==null?'-':(Math.round(v)); }
function appendLatencyRow(m){ if(!latHistoryDiv) return; const div=document.createElement('div'); div.className='row'; const fv=m.fromVoiceStart_ms; div.innerHTML=`#${m.id} T:${fmt(fv.text)} AΔ:${fmt(fv.audioDelta)} Play:${fmt(fv.audioPlay)}`; latHistoryDiv.appendChild(div); latHistoryDiv.scrollTop=latHistoryDiv.scrollHeight; }
function refreshLatencySummary(){ if(!latencyHistory.length){ latAvgText.textContent='-'; latAvgAudioDelta.textContent='-'; latAvgAudioPlay.textContent='-'; }
  let sumT=0,cT=0,sumA=0,cA=0,sumP=0,cP=0; latencyHistory.forEach(m=>{ const fv=m.fromVoiceStart_ms; if(fv.text!=null){ sumT+=fv.text; cT++; } if(fv.audioDelta!=null){ sumA+=fv.audioDelta; cA++; } if(fv.audioPlay!=null){ sumP+=fv.audioPlay; cP++; } });
  if(cT) latAvgText.textContent=(sumT/cT).toFixed(0)+' ms'; if(cA) latAvgAudioDelta.textContent=(sumA/cA).toFixed(0)+' ms'; if(cP) latAvgAudioPlay.textContent=(sumP/cP).toFixed(0)+' ms';
  if(latencyCurrentTurn && !latencyCurrentTurn.metricsEmitted){ const base=latencyCurrentTurn.tVoiceStartDetected||latencyCurrentTurn.tMicStart; const curT=latencyCurrentTurn.tFirstTextDelta? (latencyCurrentTurn.tFirstTextDelta-base):null; const curA=latencyCurrentTurn.tFirstAudioDelta? (latencyCurrentTurn.tFirstAudioDelta-base):null; const curP=latencyCurrentTurn.tFirstAudioPlay? (latencyCurrentTurn.tFirstAudioPlay-base):null; latCurrentTurn.textContent=`T:${fmt(curT)} AΔ:${fmt(curA)} P:${fmt(curP)}`; } else { latCurrentTurn.textContent='-'; }
}

btnLatToggle?.addEventListener('click',()=>{ latHistoryDiv.style.display = (latHistoryDiv.style.display==='none')?'':'none'; btnLatToggle.textContent = latHistoryDiv.style.display==='none' ? '展开' : '隐藏'; });
btnLatShow?.addEventListener('click',()=>{ latPanel.style.display=''; btnLatShow.style.display='none'; });
btnLatExport?.addEventListener('click',()=>{ if(!latencyHistory.length){ alert('没有数据'); return; } const header='id,text_ms,audioDelta_ms,audioPlay_ms,voiceStart,textFromMic,audioDeltaFromMic,audioPlayFromMic\n'; const rows=latencyHistory.map(m=>{ const fv=m.fromVoiceStart_ms; const fm=m.fromMicStart_ms; return [m.id,fv.text??'',fv.audioDelta??'',fv.audioPlay??'', '1', fm.text??'', fm.audioDelta??'', fm.audioPlay??''].join(','); }); const csv=header+rows.join('\n'); const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='latency.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000); });
btnLatClear?.addEventListener('click',()=>{ latencyHistory.length=0; latHistoryDiv.innerHTML=''; refreshLatencySummary(); });
btnLatPin?.addEventListener('click',()=>{ latPinned=!latPinned; btnLatPin.textContent = latPinned? '取消固定':'固定'; if(latPinned){ latPanel.style.opacity='1'; } });

// 初始尝试自动显示面板（无数据则保持隐藏）
setTimeout(()=>{ if(!chkShowLatency || !chkShowLatency.checked){ latPanel.style.display='none'; return; } if(latencyHistory.length===0){ latPanel.style.display=''; } }, 300);

chkShowLatency?.addEventListener('change',()=>{
  if(!chkShowLatency.checked){ latPanel.style.display='none'; }
  else { latPanel.style.display=''; refreshLatencySummary(); }
});


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
const taskTypeInput = document.getElementById('taskType');
const modelInput = document.getElementById('model');
const connTypeSelect = document.getElementById('connType');
const tempInput = document.getElementById('temp');
const maxTokensInput = document.getElementById('maxTokens');
const voiceField = document.getElementById('voiceControl') || document.getElementById('voiceField');
const voiceInput = document.getElementById('voice');
const inputLanguageField = document.getElementById('inputLanguageControl') || document.getElementById('inputLanguageField');
const inputLanguageInput = document.getElementById('inputLanguage');
const targetLanguageField = document.getElementById('targetLanguageControl') || document.getElementById('targetLanguageField');
const targetLanguageInput = document.getElementById('targetLanguage');
const systemPromptInput = document.getElementById('systemPrompt');
const enableServerTurnInput = document.getElementById('enableServerTurn');
const serverTurnThresholdInput = document.getElementById('serverTurnThreshold');
const serverTurnSilenceMsInput = document.getElementById('serverTurnSilenceMs');
const enableLocalStt = document.getElementById('enableLocalStt');
const autoSendStt = document.getElementById('autoSendStt');
const enableNativeWebSearchInput = document.getElementById('enableNativeWebSearch');
// 模型端转写暂时禁用（unknown_parameter: session.input_audio_transcription）
const enableModelTranscription = { checked:false };
const modelTranscriptionLang = { value:'auto' };
const defaultTranscriptionModel = 'gpt-realtime-whisper';
const DEFAULT_MODEL_OPTIONS=['gpt-realtime-1','gpt-realtime-1.5','gpt-realtime-2','gpt-realtime-translate','gpt-realtime-translation','gpt-realtime-whisper'];
const TASK_MODEL_OPTIONS={
  conversation:['gpt-realtime-1','gpt-realtime-1.5','gpt-realtime-2'],
  transcription:['gpt-realtime-whisper'],
  translation:['gpt-realtime-translate','gpt-realtime-translation']
};
const DEFAULT_VOICE_OPTIONS=['alloy','ash','ballad','coral','echo','sage','shimmer','verse'];
const DEFAULT_SPEECH_STYLE_INSTRUCTIONS='# 口音与语音风格\n中文回答时使用自然、清晰、稳定的标准普通话；四声和轻声自然，句尾语气按中文习惯收束。语速中等偏自然，按中文语义短语断句，不要逐词停顿。不要使用英语式重音、夸张播音腔或外国人腔。口音控制不改变回答语言；不要因为用户口音切换语言。';
const btnMcpConfig = document.getElementById('btnMcpConfig');
const mcpStatusEl = document.getElementById('mcpStatus');
const DEFAULT_TEMPERATURE=0.7;
function safeNumber(val, fallback){ if(val===undefined||val===null||val==='') return fallback; const n=Number(val); return (Number.isFinite(n)? n : fallback); }
function isManagedIdentityMode(){ return (window._cfg?.auth_mode||'').toString().toLowerCase()==='managed-identity'; }
function normalizeModelValue(value){ return (value??'').toString().trim(); }
function mergeModelOptions(options, selected){ const merged=[]; [...(Array.isArray(options)?options:DEFAULT_MODEL_OPTIONS), selected].forEach(item=>{ const value=normalizeModelValue(item); if(value && !merged.includes(value)) merged.push(value); }); return merged.length?merged:DEFAULT_MODEL_OPTIONS.slice(); }
function normalizeTaskType(value){ const normalized=(value||'conversation').toString().trim().toLowerCase(); return Object.prototype.hasOwnProperty.call(TASK_MODEL_OPTIONS, normalized) ? normalized : 'conversation'; }
function inferTaskFromModel(model){ const normalized=normalizeModelValue(model).toLowerCase(); if(normalized.includes('translation') || normalized.includes('translate')) return 'translation'; if(normalized.includes('whisper') || normalized.includes('transcrib')) return 'transcription'; return 'conversation'; }
function getCurrentTaskType(){ return normalizeTaskType(taskTypeInput?.value || inferTaskFromModel(modelInput?.value || window._cfg?.model || window._cfg?.deployment)); }
function taskUsesVoice(task=getCurrentTaskType()){ return normalizeTaskType(task)!=='transcription'; }
function taskUsesInputLanguage(task=getCurrentTaskType()){ return ['transcription','translation'].includes(normalizeTaskType(task)); }
function taskUsesTargetLanguage(task=getCurrentTaskType()){ return normalizeTaskType(task)==='translation'; }
function isAzureRealtimeConfig(){ return ((window._cfg?.provider||'').toString().toLowerCase()==='azure') || /azure\.com/i.test(window._cfg?.endpoint||''); }
function applyTaskConnectionState(task){ const normalized=normalizeTaskType(task); if(!isAzureRealtimeConfig() || !connTypeSelect) return; if(normalized==='transcription' && connTypeSelect.value==='websocket'){ connTypeSelect.value='webrtc'; log('sys','Azure 转写任务使用 GA WebRTC 路径，已切换连接方式'); } if(normalized==='translation' && connTypeSelect.value==='webrtc'){ connTypeSelect.value='websocket'; log('sys','Azure 翻译任务使用 WebSocket translations 路径，已切换连接方式'); } }
function setFieldVisible(field, visible){ if(!field) return; field.hidden=!visible; field.style.display=visible?'':'none'; }
function modelBelongsToTask(value, task){ const normalized=normalizeModelValue(value); if(!normalized) return false; const normalizedTask=normalizeTaskType(task); const preferred=TASK_MODEL_OPTIONS[normalizedTask]||TASK_MODEL_OPTIONS.conversation; if(preferred.includes(normalized)) return true; if(DEFAULT_MODEL_OPTIONS.includes(normalized)) return false; return inferTaskFromModel(normalized)===normalizedTask; }
function filterModelOptionsForTask(options, task, selected){ const merged=mergeModelOptions(options, selected); const normalizedTask=normalizeTaskType(task); const preferred=TASK_MODEL_OPTIONS[normalizedTask]||TASK_MODEL_OPTIONS.conversation; const filtered=merged.filter(value=>modelBelongsToTask(value, normalizedTask)); const selectedValue=normalizeModelValue(selected); if(selectedValue && modelBelongsToTask(selectedValue, normalizedTask) && !filtered.includes(selectedValue)) filtered.push(selectedValue); return filtered.length?filtered:preferred.slice(); }
function setModelOptions(options, selected, task=getCurrentTaskType()){
  if(!modelInput || modelInput.tagName!=='SELECT') return;
  const merged=filterModelOptionsForTask(options, task, selected);
  const selectedValue=normalizeModelValue(selected);
  modelInput.replaceChildren(...merged.map(value=>{ const opt=document.createElement('option'); opt.value=value; opt.textContent=value; return opt; }));
  modelInput.value=merged.includes(selectedValue)?selectedValue:merged[0];
}
function setModelValue(value){ if(!modelInput) return; const normalized=normalizeModelValue(value); if(!normalized) return; const task=getCurrentTaskType(); if(modelInput.tagName==='SELECT' && !Array.from(modelInput.options).some(opt=>opt.value===normalized) && modelBelongsToTask(normalized, task)){ const opt=document.createElement('option'); opt.value=normalized; opt.textContent=normalized; modelInput.appendChild(opt); } if(modelInput.tagName!=='SELECT' || Array.from(modelInput.options).some(opt=>opt.value===normalized)) modelInput.value=normalized; }
function getResolvedInputLanguage(){ return (inputLanguageInput?.value || 'auto').toString().trim(); }
function getResolvedTargetLanguage(){ return (targetLanguageInput?.value || 'en').toString().trim(); }
function applyTaskUiState({selectedModel='', forceModel=false}={}){
  const task=getCurrentTaskType();
  if(taskTypeInput && taskTypeInput.value!==task) taskTypeInput.value=task;
  const modelCandidate=forceModel ? selectedModel : (modelInput?.value || selectedModel);
  setModelOptions(window._cfg?.model_options, modelCandidate, task);
  setFieldVisible(voiceField, taskUsesVoice(task));
  setFieldVisible(inputLanguageField, taskUsesInputLanguage(task));
  setFieldVisible(targetLanguageField, taskUsesTargetLanguage(task));
  applyTaskConnectionState(task);
}
function normalizeVoiceValue(value){ return (value??'').toString().trim().toLowerCase(); }
function mergeVoiceOptions(options, selected){ const merged=[]; [...(Array.isArray(options)?options:DEFAULT_VOICE_OPTIONS), selected].forEach(item=>{ const value=normalizeVoiceValue(item); if(value && !merged.includes(value)) merged.push(value); }); return merged.length?merged:DEFAULT_VOICE_OPTIONS.slice(); }
function setVoiceOptions(options, selected){ if(!voiceInput || voiceInput.tagName!=='SELECT') return; const merged=mergeVoiceOptions(options, selected); const selectedValue=normalizeVoiceValue(selected); voiceInput.replaceChildren(...merged.map(value=>{ const opt=document.createElement('option'); opt.value=value; opt.textContent=value; return opt; })); voiceInput.value=merged.includes(selectedValue)?selectedValue:merged[0]; }
function setVoiceValue(value){ if(!voiceInput) return; const normalized=normalizeVoiceValue(value); if(!normalized) return; if(voiceInput.tagName==='SELECT' && !Array.from(voiceInput.options).some(opt=>opt.value===normalized)){ const opt=document.createElement('option'); opt.value=normalized; opt.textContent=normalized; voiceInput.appendChild(opt); } voiceInput.value=normalized; }
function getResolvedRealtimeModel(){
  const candidates=[modelInput?.value, sessionInfo?.deployment, sessionInfo?.model, window._cfg?.deployment, window._cfg?.model];
  for(const candidate of candidates){
    const value=(candidate??'').toString().trim();
    if(value) return value;
  }
  return '';
}
function getResolvedRealtimeVoice(){ if(!taskUsesVoice()) return ''; return normalizeVoiceValue(voiceInput?.value || window._cfg?.voice || ''); }
function taskRequiresGa(task=getCurrentTaskType()){ return normalizeTaskType(task)!=='conversation'; }
function taskUsesConversationLifecycle(task=getCurrentTaskType()){ return normalizeTaskType(task)==='conversation'; }
function normalizePayloadLanguage(value){ const lang=(value||'').toString().trim(); return lang && lang.toLowerCase()!=='auto' ? lang : ''; }
function getTranslationTranscriptionModel(){ return normalizeModelValue(window._cfg?.translation_transcription_model || window._cfg?.transcription_model || defaultTranscriptionModel) || defaultTranscriptionModel; }
function buildTranslationInputTranscription(){ const transcription={ model:getTranslationTranscriptionModel() }; const inputLanguage=normalizePayloadLanguage(getResolvedInputLanguage()); if(inputLanguage && !isAzureRealtimeConfig()) transcription.language=inputLanguage; return transcription; }
function buildTranslationSessionUpdatePayload({ includeInputTranscription=true }={}){ const output={ language:normalizePayloadLanguage(getResolvedTargetLanguage()) || 'en' }; const audio={ output }; if(includeInputTranscription) audio.input={ transcription:buildTranslationInputTranscription() }; return { type:'session.update', session:{ audio } }; }
function buildRealtimeSessionUpdatePayload({ includeTools=true }={}){
  const task=getCurrentTaskType();
  if(task==='transcription'){
    const transcription={ model:getResolvedRealtimeModel() || defaultTranscriptionModel };
    const inputLanguage=normalizePayloadLanguage(getResolvedInputLanguage());
    if(inputLanguage) transcription.language=inputLanguage;
    return { type:'session.update', session:{ type:'transcription', audio:{ input:{ format:{ type:'audio/pcm', rate:AUDIO_SAMPLE_RATE }, transcription, turn_detection:null } } } };
  }
  if(task==='translation'){
    return buildTranslationSessionUpdatePayload();
  }
  const session={ type:'realtime' };
  let tools=[];
  const selectedModel=getResolvedRealtimeModel();
  const selectedVoice=getResolvedRealtimeVoice();
  if(selectedModel) session.model=selectedModel;
  if(selectedVoice) session.audio={ output:{ voice:selectedVoice } };
  const sp=systemPromptInput?.value?.trim();
  if(includeTools){ tools=buildRealtimeToolsPayload(); }
  const instructions=buildConversationInstructions(sp, tools.length ? buildToolUseInstructions(tools) : '');
  if(instructions) session.instructions=instructions;
  if(includeTools){ session.tools=tools; if(tools.length) session.tool_choice='auto'; logRealtimeTools(tools); }
  return { type:'session.update', session };
}
let mcpConfig=null;
let webSearchConfig={ enabled:false, type:'web_search', allowed_domains:[], user_location:null };
function buildMicCaptureConstraints(){ return { audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 } }; }
function getConfiguredMcpServers(){ const servers=Array.isArray(mcpConfig?.servers) ? mcpConfig.servers.filter(server=>server && typeof server==='object') : (mcpConfig && mcpConfig.serverUrl ? [mcpConfig] : []); return servers.filter(server=>server.serverUrl || server.serverLabel || server.serverDescription || server.projectConnectionId || server.authorization || sanitizeList(server.allowedTools).length || (server.headers && Object.keys(server.headers).length)); }
function updateMcpStatus(){ if(!mcpStatusEl) return; const servers=getConfiguredMcpServers(); if(!servers.length){ mcpStatusEl.textContent='MCP: 未配置'; return; } const enabledServers=servers.filter(server=>server.enabled && server.serverUrl); if(!enabledServers.length){ mcpStatusEl.textContent=`MCP: 已保存 ${servers.length} 个(未启用)`; return; } if(enabledServers.length===1){ const server=enabledServers[0]; const label=server.serverLabel||server.serverUrl; mcpStatusEl.textContent=`MCP: ${label}`; return; } mcpStatusEl.textContent=`MCP: 已启用 ${enabledServers.length} 个`; }
async function refreshMcpConfig(){ try{ const resp=await fetch('/api/mcp-config',{ cache:'no-store' }); if(resp.ok){ mcpConfig=await resp.json(); } else { mcpConfig=null; } }catch(_){ mcpConfig=null; } updateMcpStatus(); }
function openMcpConfig(){ const w=window.open('/mcp.html','mcpConfig','width=520,height=640'); if(w) w.focus(); }
btnMcpConfig?.addEventListener('click', openMcpConfig);
window.addEventListener('message', ev=>{ if(ev?.data?.type==='mcp-config-updated'){ refreshMcpConfig(); }});
updateMcpStatus();

function sanitizeList(input){ if(Array.isArray(input)) return input.map(v=>String(v).trim()).filter(Boolean); if(typeof input==='string') return input.split(/[,;\n]+/).map(v=>v.trim()).filter(Boolean); return []; }
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
function normalizeHostedToolType(value){ const type=(value||'web_search').toString().trim(); return (type==='web_search'||type==='web_search_preview')? type : 'web_search'; }
function mcpUsesHeaderAuthorization(){ const provider=(window._cfg?.provider||sessionInfo?.provider||'').toString().toLowerCase(); const endpoint=sessionInfo?.endpoint || window._cfg?.endpoint || ''; return provider==='azure' || /\.azure\.com/i.test(endpoint); }
function buildNativeWebSearchToolPayload(){ const enabled=!!enableNativeWebSearchInput?.checked; if(!enabled) return null; const cfg=webSearchConfig||{}; const tool={ type:normalizeHostedToolType(cfg.type) }; const allowed=sanitizeList(cfg.allowed_domains||cfg.allowedDomains); if(allowed.length) tool.filters={ allowed_domains:allowed }; const loc=cfg.user_location; if(loc && typeof loc==='object' && !Array.isArray(loc)){ const userLocation={ type:'approximate' }; ['country','city','region','timezone'].forEach(key=>{ const value=(loc[key]||'').toString().trim(); if(value) userLocation[key]=value; }); if(Object.keys(userLocation).length>1) tool.user_location=userLocation; } return tool; }
function buildMcpToolsPayload(){ const servers=getConfiguredMcpServers(); if(!servers.length) return null; const tools=servers.filter(server=>server.enabled && server.serverUrl).map(server=>{ const tool={ type:'mcp', server_url:server.serverUrl }; const azureCompatible=mcpUsesHeaderAuthorization(); const serverLabel=(server.serverLabel || server.name || server.serverUrl || '').toString().trim(); if(serverLabel) tool.server_label=serverLabel; if(server.requireApproval && server.requireApproval!=='default') tool.require_approval=server.requireApproval; if(!azureCompatible){ if(server.serverDescription) tool.server_description=server.serverDescription; if(server.projectConnectionId) tool.project_connection_id=server.projectConnectionId; const allowedTools=sanitizeList(server.allowedTools); if(allowedTools.length) tool.allowed_tools=allowedTools; } if(server.headers && typeof server.headers==='object' && Object.keys(server.headers).length){ tool.headers={ ...server.headers }; }
    const normalized=splitAuthorizationHeader(tool.headers||{}, server.authorization);
    if(normalized.authorization){
      if(mcpUsesHeaderAuthorization()) normalized.headers.Authorization=normalized.authorization;
      else tool.authorization=normalized.authorization;
    }
    if(Object.keys(normalized.headers).length) tool.headers=normalized.headers; else delete tool.headers;
    return tool;
  });
  return tools;
}
function buildRealtimeToolsPayload(){ const tools=[]; const webSearchTool=buildNativeWebSearchToolPayload(); if(webSearchTool) tools.push(webSearchTool); const mcpTools=buildMcpToolsPayload(); if(Array.isArray(mcpTools)) tools.push(...mcpTools); return tools; }
function buildToolUseInstructions(tools){ if(!Array.isArray(tools)||!tools.length) return ''; const hasMcp=tools.some(tool=>tool.type==='mcp'); const hasWebSearch=tools.some(tool=>/^web_search/.test(tool.type||'')); const lines=['工具使用规则: 只能使用当前会话 tools 中实际提供的工具，不要臆造、假装或模拟工具结果。']; if(hasMcp) lines.push('对于天气、地图、地理位置、路线、POI、实时状态等需要外部数据的查询，如果信息足够明确，应优先调用可用的 MCP 工具；缺少城市或地点时先追问。'); if(hasWebSearch) lines.push('对于最新信息、网页事实或需要联网核验的问题，应使用 web_search 工具后再回答。'); lines.push('工具调用失败时，简要说明无法获取实时数据，不要用训练知识编造当前天气、降雨概率或未来预报。'); return lines.join('\n'); }
function mergeInstructions(base, extra){ const b=(base||'').toString().trim(); const e=(extra||'').toString().trim(); if(!e) return b; return b ? `${b}\n\n${e}` : e; }
function getSpeechStyleInstructions(){ const cfg=window._cfg||{}; const value=Object.prototype.hasOwnProperty.call(cfg,'speech_style_instructions') ? cfg.speech_style_instructions : DEFAULT_SPEECH_STYLE_INSTRUCTIONS; return (value||'').toString().trim(); }
function buildConversationInstructions(base, extra=''){ return mergeInstructions(mergeInstructions(base, getSpeechStyleInstructions()), extra); }
function stringifyForLog(value){ try{ return JSON.stringify(value,(key,val)=>{ if(/authorization|api[-_]?key|access[_-]?token|client[_-]?secret|secret|password/i.test(key)) return val ? '[redacted]' : val; if(typeof val==='string' && /^Bearer\s+/i.test(val)) return 'Bearer [redacted]'; return val; }); }catch(_){ return '[无法序列化]'; } }
function logRealtimeTools(tools){ if(!Array.isArray(tools)||!tools.length){ log('sys','工具已禁用'); return; } const labels=tools.map(tool=>tool.type==='mcp' ? `MCP:${tool.server_label||tool.server_url}` : tool.type); log('sys','工具已启用: '+labels.join(', ')); }
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
  if(modelInput){ const configuredModel=normalizeModelValue(c.model||c.deployment||''); const shouldApplyModel=force || !initialConfigLoaded || !modelInput.value; const selectedModel=shouldApplyModel ? configuredModel : modelInput.value; const inferredTask=inferTaskFromModel(selectedModel || configuredModel); if(taskTypeInput && (force || !initialConfigLoaded || !taskTypeInput.value)) taskTypeInput.value=inferredTask; const beforeModel=modelInput.value; setModelOptions(c.model_options, selectedModel, getCurrentTaskType()); if(shouldApplyModel) setModelValue(configuredModel); applyTaskUiState({ selectedModel:modelInput.value, forceModel:false }); if(modelInput.value && (modelInput.value!==beforeModel || shouldApplyModel)) assignments.push('model='+modelInput.value); }
  if(c.web_search && typeof c.web_search==='object'){ webSearchConfig={ enabled:!!c.web_search.enabled, type:normalizeHostedToolType(c.web_search.type), allowed_domains:sanitizeList(c.web_search.allowed_domains), user_location:c.web_search.user_location||null }; if(enableNativeWebSearchInput && (force || !initialConfigLoaded)) enableNativeWebSearchInput.checked=webSearchConfig.enabled; }
  if(voiceInput){ const configuredVoice=normalizeVoiceValue(c.voice||''); const shouldApplyVoice=force || !initialConfigLoaded || !voiceInput.value; const selectedVoice=shouldApplyVoice ? configuredVoice : voiceInput.value; const beforeVoice=voiceInput.value; setVoiceOptions(c.voice_options, selectedVoice); if(shouldApplyVoice) setVoiceValue(configuredVoice); if(voiceInput.value && (voiceInput.value!==beforeVoice || shouldApplyVoice)) assignments.push('voice='+voiceInput.value); }
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
  log('sys','输入音频转写字段已禁用；语音输入/输出保持启用');
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
let analyser=null; let audioCtxVis=null; let rafId=null; let remoteOutputCtx=null; let remoteOutputSource=null; let remoteOutputAnalyser=null; let remoteOutputRafId=null;
// Response tracking (for cancellation)
let activeResponseId=null; // current in-progress response id
let assistantAudioStreaming=false; // true while response.output_audio.delta events are arriving
let responseCancellable=false; // false once the response has handed off into MCP/tool execution or finished
let autoInterruptEnabled=true; // default on, can expose toggle later
Object.defineProperty(window,'__setAutoInterrupt',{ value:v=>{ autoInterruptEnabled=!!v; console.log('[autoInterruptEnabled]',autoInterruptEnabled); }});
let autoInterruptConsecFrames=4; // 需要连续多少帧语音活动才触发打断
Object.defineProperty(window,'__setAutoInterruptFrames',{ value:n=>{ const v=parseInt(n,10); if(Number.isFinite(v)&&v>0){ autoInterruptConsecFrames=v; console.log('[autoInterruptConsecFrames]',autoInterruptConsecFrames);} }});
let consecutiveVoiceFrames=0;
let interjectionActive=false; // 防止重复插话
let cancelInFlight=false; // 防止重复发送 response.cancel
let responseCreatedAt=0; // 记录最近一次 response.created 的时间戳 (performance.now)
let mcpFollowupTimer=null;
// ---- 本地简易 VAD 参数 (RMS 基于时域数据) ----
let vadRmsThreshold=0.04; // 默认阈值 (0~1). 噪声较大环境可调高 (例如 0.06)
let vadMinSilenceFrames=2; // 多少连续静音帧后重置连续语音计数
let silenceFrameCount=0;
Object.defineProperty(window,'__setVadThreshold',{ value:v=>{ const f=parseFloat(v); if(Number.isFinite(f)&&f>0){ vadRmsThreshold=f; console.log('[vadRmsThreshold]',vadRmsThreshold); } }});
Object.defineProperty(window,'__setVadSilenceReset',{ value:n=>{ const v=parseInt(n,10); if(Number.isFinite(v)&&v>=0){ vadMinSilenceFrames=v; console.log('[vadMinSilenceFrames]',vadMinSilenceFrames); } }});
// ---- Latency instrumentation ----
let latencyTurnCounter=0; // incremental id for each speech turn
let latencyCurrentTurn=null;
const latencyHistory=[]; // array of past metrics
function nowMs(){ return performance.now(); }
function startLatencyTurn(kind='voice'){
  const t=nowMs();
  latencyTurnCounter++;
  latencyCurrentTurn={ id:latencyTurnCounter, kind, conn:activeConnType||connTypeSelect?.value||'', tInputStart:t, tMicStart:t, metricsEmitted:false };
  if(kind==='text') latencyCurrentTurn.tVoiceStartDetected=t;
  if(document.getElementById('enableLatencyLog')?.checked) log('lat','启动回合 #'+latencyCurrentTurn.id+' kind='+kind);
  refreshLatencySummary();
}
function ensureLatencyTurn(kind='voice'){ if(!latencyCurrentTurn || latencyCurrentTurn.metricsEmitted) startLatencyTurn(kind); return latencyCurrentTurn; }
function markLatencyPoint(point){ const canStartTurn=['voiceStart','responseCreateSent','responseCreated'].includes(point); let lt=latencyCurrentTurn; if(!lt || lt.metricsEmitted){ if(!canStartTurn) return; lt=ensureLatencyTurn('voice'); } const t=nowMs(); const map={ voiceStart:'tVoiceStartDetected', speechStop:'tSpeechStop', commit:'tCommit', responseCreateSent:'tResponseCreateSent', responseCreated:'tResponseCreated', text:'tFirstTextDelta', audioDelta:'tFirstAudioDelta', audioPlay:'tFirstAudioPlay' }; const field=map[point]; if(!field) return; if(!lt[field]) lt[field]=t; if(point==='audioPlay') emitLatencyMetrics(true); else refreshLatencySummary(); }
function ensureLatencyVoiceStart(){ const lt=ensureLatencyTurn('voice'); if(lt && !lt.tVoiceStartDetected) markLatencyPoint('voiceStart'); }
function markLatency(event){ markLatencyPoint(event); }
function markLatencyResponseCreateSent(){ markLatencyPoint('responseCreateSent'); }
function getLatencyPrimaryBase(lt){ if(!lt) return { label:'-', value:null }; if(lt.tResponseCreateSent) return { label:'请求', value:lt.tResponseCreateSent }; if(lt.tCommit) return { label:'提交', value:lt.tCommit }; if(lt.tSpeechStop) return { label:'停说', value:lt.tSpeechStop }; if(lt.tVoiceStartDetected) return { label:'起说', value:lt.tVoiceStartDetected }; return { label:'开始', value:lt.tInputStart||lt.tMicStart||null }; }
function latencyDelta(t,base){ return t&&base ? t-base : null; }
function latencySeries(lt,base){ return { responseCreated:latencyDelta(lt.tResponseCreated,base), text:latencyDelta(lt.tFirstTextDelta,base), audioDelta:latencyDelta(lt.tFirstAudioDelta,base), audioPlay:latencyDelta(lt.tFirstAudioPlay,base) }; }
function emitLatencyMetrics(force){ if(!latencyCurrentTurn || latencyCurrentTurn.metricsEmitted) return; const lt=latencyCurrentTurn; const hasOutput=lt.tFirstTextDelta||lt.tFirstAudioDelta||lt.tFirstAudioPlay||lt.tResponseCreated; if(!force && !hasOutput) return; lt.metricsEmitted=true; const primary=getLatencyPrimaryBase(lt); const voiceBase=lt.tVoiceStartDetected||lt.tInputStart||lt.tMicStart; const inputBase=lt.tInputStart||lt.tMicStart; const metrics={ id:lt.id, kind:lt.kind||'voice', conn:lt.conn||activeConnType||'', baseLabel:primary.label, fromPrimary_ms:latencySeries(lt,primary.value), fromVoiceStart_ms:latencySeries(lt,voiceBase), fromInputStart_ms:latencySeries(lt,inputBase), points:{ inputStart:lt.tInputStart||null, voiceStart:lt.tVoiceStartDetected||null, speechStop:lt.tSpeechStop||null, commit:lt.tCommit||null, responseCreateSent:lt.tResponseCreateSent||null, responseCreated:lt.tResponseCreated||null, firstText:lt.tFirstTextDelta||null, firstAudioDelta:lt.tFirstAudioDelta||null, firstAudioPlay:lt.tFirstAudioPlay||null } };
  latencyHistory.push(metrics); if(document.getElementById('enableLatencyLog')?.checked) log('lat','回合#'+lt.id+' 基准='+metrics.baseLabel+' 延迟(ms) '+JSON.stringify(metrics.fromPrimary_ms)); window._lastLatency=metrics; refreshLatencySummary(); }
window.getLatencyHistory=()=>latencyHistory.slice();
window.printLatencySummary=()=>{ if(!latencyHistory.length){ console.log('无延迟数据'); return; } const agg={ text:0,audioDelta:0,audioPlay:0,cntText:0,cntAudioDelta:0,cntAudioPlay:0 }; latencyHistory.forEach(m=>{ const fv=m.fromPrimary_ms||{}; if(fv.text!=null){ agg.text+=fv.text; agg.cntText++; } if(fv.audioDelta!=null){ agg.audioDelta+=fv.audioDelta; agg.cntAudioDelta++; } if(fv.audioPlay!=null){ agg.audioPlay+=fv.audioPlay; agg.cntAudioPlay++; } }); const avg={ text: agg.cntText? (agg.text/agg.cntText).toFixed(1):'-', audioDelta: agg.cntAudioDelta? (agg.audioDelta/agg.cntAudioDelta).toFixed(1):'-', audioPlay: agg.cntAudioPlay? (agg.audioPlay/agg.cntAudioPlay).toFixed(1):'-' }; console.log('平均延迟(请求/提交基准, ms):', avg); };


for(let i=0;i<48;i++){ const bar=document.createElement('div'); wave.appendChild(bar);} // simple visualizer bars

function handleConnectionClosed(msg){ if(wsAudioProc){ stopWsMicStreaming(false); } if(isRecording) stopRecording(); stopRemoteOutputMonitor(); webrtcActive=false; wsActive=false; activeConnType=null; pc=null; dataChannel=null; sessionInfo=null; webrtcKey=null; activeResponse=false; activeResponseId=null; assistantAudioStreaming=false; responseCancellable=false; cancelInFlight=false; responseCreatedAt=0; secondarySessionUpdateSent=false; wsInitialSessionIncludedTools=false; if(wsFirstMessageTimer){ clearTimeout(wsFirstMessageTimer); wsFirstMessageTimer=null; } if(mcpFollowupTimer){ clearTimeout(mcpFollowupTimer); mcpFollowupTimer=null; } if(remoteAudioEl){ try{remoteAudioEl.srcObject=null;}catch(_){} remoteAudioEl.remove(); remoteAudioEl=null; } connectBtn.disabled=false; disconnectBtn.disabled=true; micBtn.disabled=true; sendTextBtn.disabled=true; setStatus('已断开'); if(msg) log('sys',msg); }

// ---- Transcription (server events) ----
function handleTranscriptionDelta(target,payload){ const chunk = payload?.delta || payload?.text || payload?.value; if(!chunk) return; if(!target._modelTrPartial) target._modelTrPartial=''; target._modelTrPartial+=chunk; if(!target._modelTrDiv){ target._modelTrDiv=document.createElement('div'); target._modelTrDiv.className='msg'; target._modelTrDiv.innerHTML='<span class="role">模型转写:</span><span class="partial"></span>'; logEl.appendChild(target._modelTrDiv);} target._modelTrDiv.querySelector('.partial').textContent=target._modelTrPartial; logEl.scrollTop=logEl.scrollHeight; }
function handleTranscriptionCompleted(target,payload){ let finalText=target._modelTrPartial||''; const extra=payload?.text||payload?.transcript||''; if(!finalText && extra) finalText=extra; log('模型转写', finalText||'[完成]'); target._modelTrPartial=''; if(target._modelTrDiv){ target._modelTrDiv.remove(); target._modelTrDiv=null; } }
function handleStreamingTextDelta(target,key,label,payload){ const chunk=payload?.delta || payload?.text || payload?.transcript || ''; if(!chunk) return; const partialKey='_'+key+'Partial'; const divKey='_'+key+'Div'; if(!target[partialKey]) target[partialKey]=''; target[partialKey]+=chunk; if(!target[divKey]){ target[divKey]=document.createElement('div'); target[divKey].className='msg'; target[divKey].innerHTML=`<span class="role">${label}:</span><span class="partial"></span>`; logEl.appendChild(target[divKey]); } target[divKey].querySelector('.partial').textContent=target[partialKey]; logEl.scrollTop=logEl.scrollHeight; }
function flushStreamingText(target,key,label){ const partialKey='_'+key+'Partial'; const divKey='_'+key+'Div'; if(target?.[partialKey]) log(label,target[partialKey]); if(target?.[divKey]){ target[divKey].remove(); target[divKey]=null; } if(target) target[partialKey]=''; }

async function readJsonOrRaw(resp){ const text=await resp.text(); if(!text) return {}; try{ return JSON.parse(text); }catch(_){ return { raw:text }; } }

// ---- Session creation (supports mode param) ----
async function createSession(){
  const mode = connTypeSelect?.value === 'websocket' ? 'ws' : 'webrtc';
  const task=getCurrentTaskType();
  const useGa = taskRequiresGa(task) || Boolean(document.getElementById('useGaPath')?.checked);
  const selectedModel=getResolvedRealtimeModel();
  const selectedVoice=taskUsesVoice(task)?getResolvedRealtimeVoice():'';
  const params=new URLSearchParams({ mode, use_v1:useGa?'1':'0', task });
  if(selectedModel) params.set('model', selectedModel);
  if(selectedVoice) params.set('voice', selectedVoice);
  if(taskUsesInputLanguage(task) && getResolvedInputLanguage() && getResolvedInputLanguage()!=='auto') params.set('input_language', getResolvedInputLanguage());
  if(taskUsesTargetLanguage(task) && getResolvedTargetLanguage()) params.set('target_language', getResolvedTargetLanguage());
  const url = '/api/realtime-session?'+params.toString();
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
  setTimeout(()=>{ try{ const previewUrl=isManagedIdentityMode()?buildWebSocketProxyUrl():buildWebSocketUrl(); log('sys','预期 WebSocket URL -> '+previewUrl); }catch(e){ log('error','预计算 WS URL 失败: '+e.message); } },0);
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
function inferRegion(){ const ep=sessionInfo?.endpoint||''; const lower=(ep||'').toLowerCase(); if(/eastus2/.test(lower)) return 'eastus2'; if(/swedencentral/.test(lower)) return 'swedencentral'; return 'eastus2'; }

// ---- Audio playback of assistant PCM ----
function ensurePlayCtx(){ if(!audioPlayCtx){ audioPlayCtx=new (window.AudioContext||window.webkitAudioContext)({ sampleRate:AUDIO_SAMPLE_RATE }); audioPlayHead=audioPlayCtx.currentTime; } if(audioPlayCtx.state==='suspended'){ audioPlayCtx.resume().catch(()=>{});} }
function playBase64Pcm(b64){ if(!b64) return; ensurePlayCtx(); try{ const raw=atob(b64); const bytes=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i); const samples=new Int16Array(bytes.buffer); const f32=new Float32Array(samples.length); for(let i=0;i<samples.length;i++) f32[i]=samples[i]/32768; const buf=audioPlayCtx.createBuffer(1,f32.length,AUDIO_SAMPLE_RATE); buf.copyToChannel(f32,0,0); const src=audioPlayCtx.createBufferSource(); src.buffer=buf; const startAt=Math.max(audioPlayCtx.currentTime,audioPlayHead); src.connect(audioPlayCtx.destination); src.start(startAt); audioPlayHead=startAt+buf.duration; markLatency('audioPlay'); }catch(err){ console.warn('音频播放失败',err.message);} }
function primeAudioPlayback(){ try{ ensurePlayCtx(); if(audioPlayCtx?.state==='running') return; audioPlayCtx?.resume?.().catch(()=>{}); }catch(_){ } }
function showOrUpdateAudioTranscript(text){ if(!_audioTranscriptDivPartial){ _audioTranscriptDivPartial=document.createElement('div'); _audioTranscriptDivPartial.className='msg'; _audioTranscriptDivPartial.innerHTML='<span class="role">助理(语音中):</span><span class="partial"></span>'; logEl.appendChild(_audioTranscriptDivPartial);} _audioTranscriptDivPartial.querySelector('.partial').textContent=text; logEl.scrollTop=logEl.scrollHeight; }
function removeAudioTranscriptPartialDiv(){ if(_audioTranscriptDivPartial){ _audioTranscriptDivPartial.remove(); _audioTranscriptDivPartial=null; } }
function stopRemoteOutputMonitor(){ if(remoteOutputRafId){ cancelAnimationFrame(remoteOutputRafId); remoteOutputRafId=null; } try{ remoteOutputSource?.disconnect(); }catch(_){} try{ remoteOutputAnalyser?.disconnect?.(); }catch(_){} try{ remoteOutputCtx?.close?.(); }catch(_){} remoteOutputCtx=null; remoteOutputSource=null; remoteOutputAnalyser=null; }
function startRemoteOutputMonitor(stream){ stopRemoteOutputMonitor(); if(!stream) return; try{ remoteOutputCtx=new (window.AudioContext||window.webkitAudioContext)(); remoteOutputSource=remoteOutputCtx.createMediaStreamSource(stream); remoteOutputAnalyser=remoteOutputCtx.createAnalyser(); remoteOutputAnalyser.fftSize=512; remoteOutputSource.connect(remoteOutputAnalyser); remoteOutputCtx.resume?.().catch(()=>{}); const data=new Uint8Array(remoteOutputAnalyser.fftSize); const tick=()=>{ if(!remoteOutputAnalyser) return; remoteOutputAnalyser.getByteTimeDomainData(data); let sumSq=0; for(let i=0;i<data.length;i++){ const sample=(data[i]-128)/128; sumSq+=sample*sample; } const rms=Math.sqrt(sumSq/data.length); if(rms>0.012 && latencyCurrentTurn && !latencyCurrentTurn.tFirstAudioPlay && (activeResponse||activeResponseId||responseCreatedAt)){ markLatency('audioPlay'); } remoteOutputRafId=requestAnimationFrame(tick); }; tick(); }catch(err){ if(verboseDebug) log('diag','远端音频延迟监测不可用: '+err.message); } }

// ---- Start (connect) ----
async function start(){ try{ applyTaskConnectionState(getCurrentTaskType()); const connType=connTypeSelect?.value||'webrtc'; await validateRealtimeAuth(); sessionInfo=await createSession(); log('sys','会话创建成功'); if(connType==='webrtc'){ if(!sessionInfo?.client_secret?.value){ log('error','缺少 WebRTC 临时密钥'); return; } await startWebRTC(); } else { await startWebSocket(); } }catch(e){ log('error','创建会话失败: '+e.message); setStatus('创建失败'); } }

// ---- WebSocket path builder (Azure OpenAI) ----
let wsPreviewLock=false; // 自动回退后锁定 preview；若用户重新勾选 GA 则解除
function sessionResolvedToPreview(){ return sessionInfo?.use_v1_path_resolved===false || /^preview/.test(sessionInfo?.path_variant||''); }
function shouldUseGaWebSocket(){ return taskRequiresGa() || (Boolean(document.getElementById('useGaPath')?.checked) && !wsPreviewLock && !sessionResolvedToPreview()); }
function isGaWebSocketUrl(url){ return /\/openai\/v1\/realtime/.test(url||'') || /[?&]use_v1=1(?:&|$)/.test(url||''); }
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
  if(shouldUseGaWebSocket()){
    if(getCurrentTaskType()==='translation') return base + '/openai/v1/realtime/translations?model=' + encodeURIComponent(deployment);
    return base + '/openai/v1/realtime?model=' + encodeURIComponent(deployment);
  }
  return base + '/openai/realtime?api-version=' + encodeURIComponent(apiVersion) + '&deployment=' + encodeURIComponent(deployment);
}

function buildWebSocketProxyUrl(){
  const deployment=getResolvedRealtimeModel();
  if(!deployment){ log('error','缺少 deployment/model，无法构建 WebSocket 代理 URL'); return ''; }
  const protocol=window.location.protocol==='https:'?'wss:':'ws:';
  const useV1=shouldUseGaWebSocket()?'1':'0';
  const params=new URLSearchParams({ model:deployment, use_v1:useV1, task:getCurrentTaskType() });
  if(taskUsesInputLanguage() && normalizePayloadLanguage(getResolvedInputLanguage())) params.set('input_language', normalizePayloadLanguage(getResolvedInputLanguage()));
  if(taskUsesTargetLanguage() && normalizePayloadLanguage(getResolvedTargetLanguage())) params.set('target_language', normalizePayloadLanguage(getResolvedTargetLanguage()));
  return `${protocol}//${window.location.host}/realtime-proxy?${params.toString()}`;
}

let ws=null; let wsActive=false; let wsFirstMessageTimer=null; let wsConnectedAt=0; let wsReceivedAny=false; let wsUrlLast=''; let secondarySessionUpdateSent=false; let wsInitialSessionIncludedTools=false;
window.__wsRef=()=>ws; // 简单全局引用供调试
// Raw frame & event debug toggles
let rawFrameDebug=false; // 默认关闭，可在控制台设 window.__rawFrameDebug=true 打开
Object.defineProperty(window,'__rawFrameDebug',{ get(){ return rawFrameDebug; }, set(v){ rawFrameDebug=!!v; console.log('[rawFrameDebug]',rawFrameDebug); }});
async function fetchWsKey(){
  try{ const r=await fetch('/api/realtime-ws-key',{ cache:'no-store' }); if(!r.ok) return null; const j=await r.json(); return j.api_key||null; }catch(_){ return null; }
}

function startWebSocket(){
  return new Promise(async (resolve,reject)=>{
    const useProxy=(sessionInfo?.auth_mode_resolved||window._cfg?.auth_mode||'').toLowerCase()==='managed-identity' || getCurrentTaskType()==='translation';
    let url=useProxy?buildWebSocketProxyUrl():buildWebSocketUrl(); wsUrlLast=url;
    if(!url){ reject(new Error('缺少 WebSocket 连接参数')); return; }
    let connectUrl=url;
    if(useProxy){
      log('sys',getCurrentTaskType()==='translation' ? '翻译任务使用本地 WebSocket 代理' : 'managed identity 模式使用本地 WebSocket 代理');
    } else {
      const apiKey = await fetchWsKey();
      if(apiKey){
        connectUrl += (connectUrl.includes('?')?'&':'?') + 'api-key=' + encodeURIComponent(apiKey);
      } else {
        log('warn','未能获取 API Key，将尝试无鉴权连接(可能被服务器拒绝)');
      }
    }
    log('sys','WebSocket 连接 -> '+url+(useProxy?' (proxy)':''));
    try{
  ws=new WebSocket(connectUrl,['realtime']);
  // Outbound frame interceptor
  const _origSend=ws.send.bind(ws);
  ws.send=function(data){ try{ if(rawFrameDebug){ log('out', (typeof data==='string'? data.slice(0,800):'[binary]')); } }catch(_){ } return _origSend(data); };
      ws.addEventListener('open',()=>{ wsActive=true; wsConnectedAt=performance.now(); wsReceivedAny=false; activeConnType='websocket';
        secondarySessionUpdateSent=false;
        log('diag','WS open url='+wsUrlLast+' path_variant='+ (sessionInfo?.path_variant)+' v1_resolved='+(sessionInfo?.use_v1_path_resolved)+' readyState='+ws.readyState);
        connectBtn.disabled=true; disconnectBtn.disabled=false; micBtn.disabled=false; sendTextBtn.disabled=!taskUsesConversationLifecycle(); setStatus('已连接(WebSocket)'); resolve();
        const initSession=(taskUsesConversationLifecycle() && !shouldUseGaWebSocket()) ? { type:'session.update', session:{} } : buildRealtimeSessionUpdatePayload({ includeTools:taskUsesConversationLifecycle() });
        wsInitialSessionIncludedTools=Array.isArray(initSession?.session?.tools) && initSession.session.tools.length>0;
        try{ log('sys','初始 session.update: '+stringifyForLog(initSession)); }catch(_){ }
        ws.send(JSON.stringify(initSession));
          wsFirstMessageTimer=setTimeout(()=>{ if(!wsReceivedAny && isGaWebSocketUrl(wsUrlLast) && taskUsesConversationLifecycle()){ log('warn','GA WebSocket 无响应，尝试 preview 回退'); attemptWebSocketPreviewFallback(); } },800);
      });
      ws.addEventListener('message', handleWsMessage);
        ws.addEventListener('close', ev=>{ wsActive=false; if(wsFirstMessageTimer){ clearTimeout(wsFirstMessageTimer); wsFirstMessageTimer=null; } log('diag','WS close code='+ev.code+' reason='+(ev.reason||'')+' duration_ms='+(performance.now()-wsConnectedAt).toFixed(0)); if(!wsReceivedAny && isGaWebSocketUrl(wsUrlLast) && taskUsesConversationLifecycle() && attemptWebSocketPreviewFallback({ force:true })){ return; } log('error','WebSocket 已关闭 code='+ev.code+' reason='+(ev.reason||'')); handleConnectionClosed('WebSocket 已关闭'); });
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
  if(handleRealtimeToolEvent(ws,msg)) return;
  switch(type){
    case 'session.updated':
      scheduleSecondarySessionUpdate();
      break;
    case 'session.output_audio.delta':
      markLatency('audioDelta');
      if(!ws._translationAudioLogged){ ws._translationAudioLogged=true; log('sys','收到翻译音频片段'); }
      playBase64Pcm(msg.delta);
      assistantAudioStreaming=true;
      break;
    case 'session.output_transcript.delta':
      markLatency('text');
      handleStreamingTextDelta(ws,'translationOutput','翻译',msg);
      break;
    case 'session.input_transcript.delta':
      handleStreamingTextDelta(ws,'translationInput','源转写',msg);
      break;
    case 'session.closed':
      flushStreamingText(ws,'translationInput','源转写');
      flushStreamingText(ws,'translationOutput','翻译');
      emitLatencyMetrics(true);
      log('sys','翻译会话已关闭');
      break;
    case 'response.created':
      activeResponseId = msg.response?.id || null;
      activeResponse=true;
      responseCancellable=true;
      responseCreatedAt=performance.now();
      markLatencyPoint('responseCreated');
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
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta': // streaming transcript text
      if(typeof msg.delta==='string'){ audioTranscriptPartial+=msg.delta; showOrUpdateAudioTranscript(audioTranscriptPartial); markLatency('text'); }
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      if(msg.transcript){
        audioTranscriptPartial=msg.transcript; // ensure full
        log('assistant', audioTranscriptPartial);
        removeAudioTranscriptPartialDiv();
        audioTranscriptPartial='';
      }
      break;
    case 'response.audio.delta':
    case 'response.output_audio.delta': // PCM audio chunks (base64)
      markLatency('audioDelta');
      playBase64Pcm(msg.delta);
      assistantAudioStreaming=true;
      break;
    case 'response.audio.done':
      break;
    case 'input_audio_buffer.speech_started':
      ensureLatencyVoiceStart();
      break;
    case 'input_audio_buffer.speech_stopped':
      markLatencyPoint('speechStop');
      break;
    case 'input_audio_buffer.committed':
      markLatencyPoint('commit');
      break;
    case 'conversation.item.created':
    case 'conversation.item.added':
      if(msg.item?.role==='user') markLatencyPoint('commit');
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
      responseCancellable=false;
      activeResponseId=null;
      cancelInFlight=false;
      responseCreatedAt=0;
      break;
    case 'response.cancelled':
      log('warn','响应已取消');
      activeResponse=false; activeResponseId=null; ws._partial=''; ws._partialDiv=null; removeAudioTranscriptPartialDiv();
      assistantAudioStreaming=false;
      responseCancellable=false;
      cancelInFlight=false;
      responseCreatedAt=0;
      break;
    case 'error':
      if(msg?.error?.code==='response_cancel_not_active'){
        activeResponse=false;
        activeResponseId=null;
        assistantAudioStreaming=false;
        responseCancellable=false;
        cancelInFlight=false;
        responseCreatedAt=0;
        log('diag','response.cancel 被服务端忽略：当前已无活动响应');
        break;
      }
      if(getCurrentTaskType()==='translation' && !ws._translationTranscriptionFallbackSent){
        const text=stringifyForLog(msg.error||msg);
        if(/transcription|audio\.input|input.*audio|unknown_parameter|invalid_request|validation/i.test(text)){
          ws._translationTranscriptionFallbackSent=true;
          try{ ws.send(JSON.stringify(buildTranslationSessionUpdatePayload({ includeInputTranscription:false }))); log('warn','翻译源转写配置被拒绝，已退回仅翻译输出模式'); }catch(_){ }
        }
      }
      log('error', msg.error||msg);
      break;
    default:
      if(/transcription\.delta$/.test(type)){ handleTranscriptionDelta(ws,msg); }
      else if(/transcription\.completed$/.test(type)){ handleTranscriptionCompleted(ws,msg); }
      break;
  }
}

function scheduleSecondarySessionUpdate(){ if(!taskUsesConversationLifecycle()) return; if(secondarySessionUpdateSent) return; secondarySessionUpdateSent=true; setTimeout(()=>{ if(!wsActive || ws?.readyState!==WebSocket.OPEN) return; const sp=systemPromptInput?.value?.trim(); const payload={ type:'session.update', session:{} }; const isAzure = /\.azure\.com/i.test(sessionInfo?.endpoint||''); const currentUrl=wsUrlLast||''; const isGaWs=/\/openai\/v1\/realtime/.test(currentUrl) || /[?&]use_v1=1(?:&|$)/.test(currentUrl); if(isGaWs && wsInitialSessionIncludedTools){ log('diag','跳过二次 session.update：初始更新已包含 tools'); return; } if(isGaWs) payload.session.type='realtime';
  // Azure preview 对 hosted tools 兼容性不稳定，仍只在 GA v1 WebSocket 发送。
  if(isAzure){
    if(isGaWs){ const tools=buildRealtimeToolsPayload(); payload.session.tools=tools; if(tools.length){ payload.session.tool_choice='auto'; payload.session.instructions=buildConversationInstructions(sp, buildToolUseInstructions(tools)); } else { const instructions=buildConversationInstructions(sp); if(instructions) payload.session.instructions=instructions; } logRealtimeTools(tools); }
    else { const instructions=buildConversationInstructions(sp); if(instructions){ payload.session.instructions=instructions; } log('sys','Preview 不发送 hosted tools'); }
  } else { const tools=buildRealtimeToolsPayload(); payload.session.tools=tools; if(tools.length){ payload.session.tool_choice='auto'; payload.session.instructions=buildConversationInstructions(sp, buildToolUseInstructions(tools)); } else { const instructions=buildConversationInstructions(sp); if(instructions) payload.session.instructions=instructions; } logRealtimeTools(tools); }
  try{ log('sys','二次 session.update (扩展) : '+stringifyForLog(payload)); }catch(_){ } ws.send(JSON.stringify(payload)); },50); }

function attemptWebSocketPreviewFallback(options={}){
  if(!sessionInfo) return false;
  if(!taskUsesConversationLifecycle()) return false;
  if(wsPreviewLock) return false; // 已回退
  const force=Boolean(options.force);
  if(!force && document.getElementById('useGaPath')?.checked && !sessionResolvedToPreview()){ log('warn','用户已强制 GA，跳过自动 preview 回退'); return false; }
  wsPreviewLock=true;
  sessionInfo.path_variant='preview-fallback-client';
  sessionInfo.use_v1_path_resolved=false;
  if(ws && ws.readyState===WebSocket.OPEN){ try{ ws.close(4000,'client-fallback'); }catch(_){ } }
  setTimeout(()=>{ log('sys','发起 preview WebSocket 回退重连'); startWebSocket().catch(e=>log('error','回退重连失败: '+e.message)); },100);
  return true;
}

let mcpToolsLoading=false;
let mcpToolsReady=false;
let mcpLoadedToolNames=[];
function compactToolLog(value, maxLen=700){ const text=typeof value==='string' ? value : stringifyForLog(value); return text.length>maxLen ? text.slice(0,maxLen)+'...' : text; }
function getMcpToolNames(item){ return Array.isArray(item?.tools) ? item.tools.map(tool=>tool?.name).filter(Boolean) : []; }
function realtimeTargetIsOpen(target){ return target && (target.readyState===WebSocket.OPEN || target.readyState==='open'); }
function scheduleMcpResultFollowup(target){
  if(mcpFollowupTimer) clearTimeout(mcpFollowupTimer);
  mcpFollowupTimer=setTimeout(()=>{
    mcpFollowupTimer=null;
    if(!taskUsesConversationLifecycle() || activeResponse || !realtimeTargetIsOpen(target)) return;
    const payload={ type:'response.create', response:{ tool_choice:'none', instructions:'请基于刚刚的 MCP 工具结果回答用户；不要再次调用工具，不要编造工具结果之外的实时数据。' } };
    try{
      markLatencyResponseCreateSent();
      target.send(JSON.stringify(payload));
      activeResponse=true;
      log('sys','MCP 工具结果已返回，发送最终回答 response.create');
    }catch(err){ log('error','发送 MCP 最终回答失败: '+err.message); }
  },900);
}
function handleRealtimeToolEvent(target,msg){
  const type=msg?.type||'';
  if(type==='mcp_list_tools.in_progress'){
    mcpToolsLoading=true; mcpToolsReady=false;
    log('sys','MCP 工具列表加载中');
    return true;
  }
  if(type==='mcp_list_tools.completed'){
    mcpToolsLoading=false;
    log('sys','MCP 工具列表加载完成');
    return true;
  }
  if(type==='mcp_list_tools.failed'){
    mcpToolsLoading=false; mcpToolsReady=false;
    log('error','MCP 工具列表加载失败: '+compactToolLog(msg.error||msg));
    return true;
  }
  if(type==='conversation.item.done' || type==='conversation.item.created'){
    const item=msg.item||{};
    if(item.type==='mcp_list_tools'){
      mcpToolsReady=true; mcpToolsLoading=false; mcpLoadedToolNames=getMcpToolNames(item);
      log('sys',mcpLoadedToolNames.length ? 'MCP 工具已加载: '+mcpLoadedToolNames.join(', ') : 'MCP 工具已加载');
      return true;
    }
    if(item.type==='mcp_approval_request'){
      log('warn','MCP 调用需要审批: '+(item.server_label||'MCP')+'.'+(item.name||'unknown')+' '+compactToolLog(item.arguments||''));
      return true;
    }
  }
  if(type==='response.mcp_call_arguments.done'){
    log('sys','MCP 调用参数: '+compactToolLog(msg.arguments||''));
    return true;
  }
  if(type==='response.mcp_call_arguments.delta') return true;
  if(type==='response.mcp_call.in_progress'){
    responseCancellable=false;
    log('sys','MCP 工具调用中');
    return true;
  }
  if(type==='response.mcp_call.completed'){
    log('sys','MCP 工具调用完成');
    return true;
  }
  if(type==='response.mcp_call.failed'){
    log('error','MCP 工具调用失败: '+compactToolLog(msg.error||msg));
    return true;
  }
  if(type==='response.output_item.added'){
    const item=msg.item||{};
    if(item.type==='mcp_call'){
      responseCancellable=false;
      log('sys','准备调用 MCP: '+(item.server_label||'MCP')+'.'+(item.name||'unknown'));
      return true;
    }
    if(item.type==='function_call'){
      log('sys','模型请求 function 工具: '+(item.name||'unknown'));
      return true;
    }
  }
  if(type==='response.output_item.done'){
    const item=msg.item||{};
    if(item.type==='mcp_call'){
      const label=(item.server_label||'MCP')+'.'+(item.name||'unknown');
      if(item.error) log('error','MCP 输出错误 '+label+': '+compactToolLog(item.error));
      else { log('sys','MCP 输出 '+label+': '+compactToolLog(item.output||'')); scheduleMcpResultFollowup(target); }
      return true;
    }
    if(item.type==='function_call'){
      log('warn','收到 function_call 但当前示例未实现本地函数执行: '+(item.name||'unknown'));
      return true;
    }
  }
  return false;
}

// 监听 GA 复选框，用户重新勾选则解除 preview 锁并提示需要重连
document.getElementById('useGaPath')?.addEventListener('change', e=>{
  const cb=e.target; if(cb.checked){ if(wsPreviewLock){ wsPreviewLock=false; log('sys','GA 勾选 -> 解除 preview 锁，下次连接将使用 GA'); } if(wsActive){ log('sys','请断开并重新连接以切换到 GA WebSocket'); } }
});

// (统一版本) 文本发送，自动检测当前连接类型
function sendTextUnified(){
  const txt=textInput.value.trim();
  if(!txt) return;
  if(!taskUsesConversationLifecycle()){
    log('warn','当前任务类型不使用文本对话/response.create，请使用麦克风音频流。');
    return;
  }
  const usingWs = (activeConnType==='websocket');
  // 统一延迟回合逻辑
  if(!latencyCurrentTurn || latencyCurrentTurn.metricsEmitted){ startLatencyTurn('text'); }
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
function canAttachRealtimeToolsToResponse(){
  if(!taskUsesConversationLifecycle()) return false;
  const endpoint=sessionInfo?.endpoint || window._cfg?.endpoint || '';
  const isAzure=/\.azure\.com/i.test(endpoint);
  if(isAzure && activeConnType==='websocket' && !isGaWebSocketUrl(wsUrlLast)) return false;
  if(isAzure && activeConnType==='webrtc' && sessionResolvedToPreview()) return false;
  return true;
}
function buildResponseCreateConfig(extra={}){
  const response={ ...extra };
  if(canAttachRealtimeToolsToResponse()){
    const tools=buildRealtimeToolsPayload();
    if(tools.length){
      response.tools=tools;
      response.tool_choice='auto';
      response.instructions=buildConversationInstructions(response.instructions, buildToolUseInstructions(tools));
      logRealtimeTools(tools);
    }
  }
  if(!response.instructions) response.instructions=buildConversationInstructions('');
  return response;
}
function sendAdaptiveResponseCreate(kind){
  const isWs = kind==='ws';
  const target = isWs? ws : dataChannel;
  if(!target) return;
  const startTs=performance.now();
  const baseResponse=buildResponseCreateConfig();
  const hasTools=Array.isArray(baseResponse.tools) && baseResponse.tools.length>0;
  const variants=hasTools ? [
    { style:'withTools', payload:{ type:'response.create', response:baseResponse } },
    { style:'withToolsMetadata', payload:{ type:'response.create', response:{ ...baseResponse, metadata:{ client_probe: true } } } },
    { style:'minimalFallback', payload:{ type:'response.create', response:{} } },
  ] : [
    { style:'minimal', payload:{ type:'response.create', response:{} } },
    { style:'withEmptyInstructions', payload:{ type:'response.create', response:{ instructions:'' } } },
    { style:'withMetadata', payload:{ type:'response.create', response:{ metadata:{ client_probe: true } } } },
    { style:'forceRetryMinimal', payload:{ type:'response.create', response:{} } },
  ];
  let idx=0;
  function sendNext(){
    if(idx>=variants.length){ log('error','已发送所有探针变体仍无响应'); return; }
    const v=variants[idx++];
    try{ markLatencyResponseCreateSent(); target.send(JSON.stringify(v.payload)); activeResponse=true; lastResponseCreateStyle=v.style; log('sys','发送 response.create 变体 style='+v.style); }
    catch(e){ log('error','发送 response.create('+v.style+') 失败: '+e.message); return; }
    scheduleCheck(v.style);
  }
  function scheduleCheck(style){
    setTimeout(()=>{
      if(!activeResponse || activeResponseId || assistantAudioStreaming || wsReceivedAny || (ws && ws._partial) || (dataChannel && dataChannel._partial) || audioTranscriptPartial) return; // 已有输出或响应完成
      log('warn','response.create style='+style+' 超时无响应，尝试下一个变体');
      // 如果 session 中带 tools 可能被阻塞，尝试一次移除 tools
      if(style==='withMetadata' && sessionInfo){
        try{
          if(ws && ws.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({ type:'session.update', session:{ tools:[] }})); log('warn','探针：移除 tools 再次尝试'); }
        }catch(_){ }
      }
      sendNext();
    }, style==='minimal'?1200: (style==='withEmptyInstructions'?1400:1600));
  }
  sendNext();
}

window.__dumpConn=()=>{ try{ const snap={ wsActive, wsReady: ws? ws.readyState:undefined, activeConnType, hasPartial: !!(ws&&ws._partial), receivedAny: wsReceivedAny, lastResponseCreateStyle, dcState: dataChannel?.readyState }; console.log('[conn]',snap); log('diag','snapshot '+JSON.stringify(snap)); }catch(e){ console.log(e); } };

function disconnect(){ if(ws && ws.readyState!==WebSocket.CLOSED && ws.readyState!==WebSocket.CLOSING){ try{ ws.close(1000,'client-disconnect'); }catch(_){} } if(dataChannel && dataChannel.readyState!=='closed'){ try{ dataChannel.close(); }catch(_){} } if(pc && pc.signalingState!=='closed'){ try{ pc.close(); }catch(_){} } handleConnectionClosed('已断开'); }

function buildWebRtcUrl(selectedModel){
  const base=(sessionInfo?.endpoint||window._cfg?.endpoint||'').replace(/\/$/,'');
  if(base && !sessionResolvedToPreview()){
    const task=getCurrentTaskType();
    return base + (task==='translation' ? '/openai/v1/realtime/translations/calls' : '/openai/v1/realtime/calls');
  }
  const region=inferRegion();
  const realtimeHost=sessionResolvedToPreview() ? 'realtimeapi-preview' : 'realtimeapi';
  return `https://${region}.${realtimeHost}.ai.azure.com/v1/realtimertc?model=${encodeURIComponent(selectedModel)}`;
}

async function startWebRTC(){ webrtcKey=sessionInfo.client_secret.value; const selectedModel=getResolvedRealtimeModel(); if(!selectedModel){ log('error','缺少 deployment/model，无法发起 WebRTC'); return; } const rtcUrl=buildWebRtcUrl(selectedModel); log('sys','WebRTC offer -> '+rtcUrl); pc=new RTCPeerConnection(); remoteAudioEl=document.createElement('audio'); remoteAudioEl.autoplay=true; document.body.appendChild(remoteAudioEl); pc.ontrack=ev=>{ const stream=ev.streams[0]; remoteAudioEl.srcObject=stream; startRemoteOutputMonitor(stream); };
  dataChannel=pc.createDataChannel('realtime'); dataChannel.addEventListener('open',()=>{ log('sys','DataChannel 打开'); webrtcActive=true; activeConnType='webrtc'; activeResponse=false; connectBtn.disabled=true; disconnectBtn.disabled=false; micBtn.disabled=false; sendTextBtn.disabled=!taskUsesConversationLifecycle(); setStatus('已连接(WebRTC)'); const init=buildRealtimeSessionUpdatePayload({ includeTools:taskUsesConversationLifecycle() }); log('sys','session.update payload: '+stringifyForLog(init)); dataChannel.send(JSON.stringify(init)); if(enableServerTurnInput?.checked && taskUsesConversationLifecycle()) log('sys','服务器断句已启用(默认)'); if(document.getElementById('enableLatencyLog')?.checked) log('lat','(WebRTC) 音频通过 RTP 轨道传输, 不会出现 response.audio.delta 事件'); }); dataChannel.addEventListener('message', onDataChannelMessage); dataChannel.addEventListener('close', ()=> handleConnectionClosed('DataChannel 已关闭')); try{ audioStream=await navigator.mediaDevices.getUserMedia(buildMicCaptureConstraints()); audioStream.getAudioTracks().forEach(t=>pc.addTrack(t,audioStream)); }catch(e){ log('error','麦克风失败: '+e.message); }
  const offer=await pc.createOffer(); await pc.setLocalDescription(offer); const resp=await fetch(rtcUrl,{ method:'POST', body: offer.sdp, headers:{ 'Authorization':`Bearer ${webrtcKey}`, 'Content-Type':'application/sdp' } }); if(!resp.ok){ log('error','WebRTC offer 失败: '+resp.status); return; } const answer=await resp.text(); await pc.setRemoteDescription({ type:'answer', sdp:answer }); }

function finishDataChannelResponse(type){ if(dataChannel?._partial){ log('assistant', dataChannel._partial); } else if(type==='response.completed'){ log('assistant','[完成]'); } if(dataChannel){ dataChannel._partial=''; dataChannel._partialDiv=null; } activeResponse=false; assistantAudioStreaming=false; responseCancellable=false; activeResponseId=null; cancelInFlight=false; responseCreatedAt=0; emitLatencyMetrics(true); }
function onDataChannelMessage(e){ try{ const msg=JSON.parse(e.data); const type=msg.type||''; if(handleRealtimeToolEvent(dataChannel,msg)) return; if(type==='response.output_text.delta'){ markLatency('text'); if(!dataChannel._partial) dataChannel._partial=''; dataChannel._partial+=msg.delta; if(!dataChannel._partialDiv){ dataChannel._partialDiv=document.createElement('div'); dataChannel._partialDiv.className='msg'; dataChannel._partialDiv.innerHTML='<span class="role">助理:</span><span class="partial"></span>'; logEl.appendChild(dataChannel._partialDiv);} dataChannel._partialDiv.querySelector('.partial').textContent=dataChannel._partial; }
  else if(type==='response.created'){ activeResponseId=msg.response?.id||null; activeResponse=true; responseCancellable=true; responseCreatedAt=performance.now(); markLatencyPoint('responseCreated'); if(verboseDebug) log('diag','response.created id='+activeResponseId); }
  else if(type==='session.output_audio.delta'){ markLatency('audioDelta'); playBase64Pcm(msg.delta); assistantAudioStreaming=true; }
  else if(type==='session.output_transcript.delta'){ markLatency('text'); handleStreamingTextDelta(dataChannel,'translationOutput','翻译',msg); }
  else if(type==='session.input_transcript.delta'){ handleStreamingTextDelta(dataChannel,'translationInput','源转写',msg); }
  else if(type==='session.closed'){ flushStreamingText(dataChannel,'translationInput','源转写'); flushStreamingText(dataChannel,'translationOutput','翻译'); emitLatencyMetrics(true); log('sys','翻译会话已关闭'); }
  else if(type==='response.audio.delta' || type==='response.output_audio.delta'){ markLatency('audioDelta'); playBase64Pcm(msg.delta); assistantAudioStreaming=true; }
  else if(type==='response.audio_transcript.delta' || type==='response.output_audio_transcript.delta'){ if(typeof msg.delta==='string'){ audioTranscriptPartial+=msg.delta; showOrUpdateAudioTranscript(audioTranscriptPartial); markLatency('text'); } }
  else if(type==='response.audio_transcript.done' || type==='response.output_audio_transcript.done'){ if(msg.transcript && !audioTranscriptPartial.endsWith(msg.transcript)) audioTranscriptPartial+=msg.transcript; if(audioTranscriptPartial){ log('助理(语音转写)', audioTranscriptPartial); audioTranscriptPartial=''; removeAudioTranscriptPartialDiv(); } }
  else if(type==='response.done' || type==='response.completed'){ finishDataChannelResponse(type); }
  else if(type==='response.cancelled'){ log('warn','响应已取消'); activeResponse=false; assistantAudioStreaming=false; responseCancellable=false; activeResponseId=null; cancelInFlight=false; responseCreatedAt=0; if(dataChannel){ dataChannel._partial=''; dataChannel._partialDiv=null; } removeAudioTranscriptPartialDiv(); }
  else if(type==='input_audio_buffer.speech_started'){ ensureLatencyVoiceStart(); }
  else if(type==='input_audio_buffer.speech_stopped'){ markLatencyPoint('speechStop'); }
  else if(type==='input_audio_buffer.committed'){ markLatencyPoint('commit'); }
  else if((type==='conversation.item.created'||type==='conversation.item.added') && msg.item?.role==='user'){ markLatencyPoint('commit'); }
  else if(/transcription\.delta$/.test(type)){ handleTranscriptionDelta(dataChannel,msg); }
  else if(/transcription\.completed$/.test(type)){ handleTranscriptionCompleted(dataChannel,msg); }
  else if(type==='error'){ log('error', msg.error||msg); }
}catch(err){ log('raw', e.data.slice(0,200)); } }

// ---- Mic handling (WebRTC already sending track) ----
async function toggleMic(){ if(isRecording){ stopRecording(); return; } if(!audioStream){ audioStream=await navigator.mediaDevices.getUserMedia(buildMicCaptureConstraints()); if(pc){ audioStream.getAudioTracks().forEach(t=>pc.addTrack(t,audioStream)); } } // simple local RMS visualizer
  try{ audioCtxVis = audioCtxVis || new (window.AudioContext||window.webkitAudioContext)(); const src=audioCtxVis.createMediaStreamSource(audioStream); analyser=audioCtxVis.createAnalyser(); analyser.fftSize=256; src.connect(analyser); visualize(); }catch(_){ }
  if(enableLocalStt.checked) startLocalSTT(); isRecording=true; micBtn.textContent='停止说话'; log('sys','麦克风已开启'); startLatencyTurn('voice'); }
function stopRecording(){ markLatencyPoint('speechStop'); if(wsAudioProc){ stopWsMicStreaming(false); } if(audioStream){ audioStream.getTracks().forEach(t=>t.stop()); audioStream=null; } cancelAnimationFrame(rafId); if(sttActive) stopLocalSTT(); isRecording=false; micBtn.textContent='开始说话'; Array.from(wave.children).forEach(c=>{ c.style.height='4px'; c.classList.remove('active'); }); log('sys','麦克风已关闭'); }

// ---- Text send ----
// 兼容旧函数名（仍可能被外部脚本调用）
function sendText(){ return sendTextUnified(); }

// ---- Session Update ----
function buildTranscriptionPreference(){ return null; }
function applyTranscriptionPreference(target,{forceNullWhenDisabled}={}){ if(forceNullWhenDisabled){ /* no-op: 不发送该字段 */ } }
function sendSessionUpdate(){ const target=(webrtcActive && dataChannel?.readyState==='open') ? dataChannel : ((wsActive && ws?.readyState===WebSocket.OPEN) ? ws : null); if(!target) return; const payload=buildRealtimeSessionUpdatePayload({ includeTools:taskUsesConversationLifecycle() }); log('sys','session.update payload: '+stringifyForLog(payload)); target.send(JSON.stringify(payload)); log('sys','已更新会话'); }

function handleTaskTypeChanged(){ const task=getCurrentTaskType(); const configured=normalizeModelValue(window._cfg?.model || window._cfg?.deployment || ''); const selected=modelBelongsToTask(modelInput?.value, task) ? modelInput.value : (modelBelongsToTask(configured, task) ? configured : ''); applyTaskUiState({ selectedModel:selected, forceModel:true }); sendSessionUpdate(); }
taskTypeInput?.addEventListener('change', handleTaskTypeChanged);
[modelInput,tempInput,maxTokensInput,voiceInput,systemPromptInput,enableNativeWebSearchInput,inputLanguageInput,targetLanguageInput].forEach(el=> el && el.addEventListener('change',()=>sendSessionUpdate()));
[enableServerTurnInput,serverTurnThresholdInput,serverTurnSilenceMsInput].forEach(el=> el && el.addEventListener('change',()=>sendSessionUpdate()));
applyTaskUiState({ selectedModel:modelInput?.value || '', forceModel:false });

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
      const canAutoInterruptNow = !assistantAudioStreaming && canInterruptEarly; // 仅允许在助理尚未开始播音的早期窗口自动插话
      if(autoInterruptEnabled && canAutoInterruptNow && activeResponseId && !cancelInFlight){
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
// 当活动连接类型为 websocket 时，采集麦克风并将 16bit PCM(24kHz) base64 分块发送给实时 API。
// 对话模式 commit 后触发 response.create；转写只 commit；翻译使用专用 session.* 事件持续流式输出。
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
  if(activeConnType!=='websocket' || !wsActive || !ws || ws.readyState!==WebSocket.OPEN){
    if(verboseDebug) log('diag','WS 未就绪，丢弃残留音频分片');
    return;
  }
  const bytes = new Uint8Array(merged.buffer);
  let binary=''; for(let i=0;i<bytes.length;i++){ binary+=String.fromCharCode(bytes[i]); }
  const b64 = btoa(binary);
  const appendType=getCurrentTaskType()==='translation' ? 'session.input_audio_buffer.append' : 'input_audio_buffer.append';
  try{ ws.send(JSON.stringify({ type:appendType, audio: b64 })); if(verboseDebug) log('out','['+appendType+' '+merged.length+' samples]'); }catch(err){ log('error','发送音频块失败: '+err.message); }
}

function stopWsMicStreaming(commit=true){
  try{ if(wsAudioProc){ wsAudioProc.disconnect(); wsAudioProc.onaudioprocess=null; } if(wsAudioCtx){ wsAudioCtx.close().catch(()=>{}); } }catch(_){ }
  wsAudioProc=null; wsAudioCtx=null;
  if(commit) flushWsAudioChunk(); else wsAudioBuffer=[];
  if(commit && activeConnType==='websocket' && wsActive && ws?.readyState===WebSocket.OPEN){
    const task=getCurrentTaskType();
    const ms = wsTotalSamples / WS_STREAM_TARGET_RATE * 1000;
    if(task==='translation'){
      markLatencyPoint('speechStop');
      try{ ws.send(JSON.stringify({ type:'session.close' })); log('sys','发送 session.close (翻译会话)'); }catch(err){ log('error','关闭翻译会话失败: '+err.message); }
      wsTotalSamples=0;
      return;
    }
    if(ms < 120){
      log('warn',`音频过短(${ms.toFixed(0)}ms) 跳过提交与推理`);
    } else {
      markLatencyPoint('speechStop');
      try{ ws.send(JSON.stringify({ type:'input_audio_buffer.commit' })); markLatencyPoint('commit'); log('sys','WS 音频提交'); }catch(err){ log('error','提交音频失败: '+err.message); }
      if(taskUsesConversationLifecycle(task)){
        try{ markLatencyResponseCreateSent(); ws.send(JSON.stringify({ type:'response.create', response:{} })); activeResponse=true; lastResponseCreateStyle='minimal'; log('sys','发送 response.create (音频会话)'); }catch(err){ log('error','发送 response.create 失败: '+err.message); }
      } else {
        log('sys','转写会话已提交音频，等待转写事件');
      }
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
  if(!responseCancellable){ if(verboseDebug) log('diag','当前响应已不可取消，忽略 response.cancel'); return; }
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
connectBtn.addEventListener('click',()=>{ primeAudioPlayback(); start(); }); disconnectBtn.addEventListener('click', disconnect); micBtn.addEventListener('click',()=>{ primeAudioPlayback(); toggleMic(); }); sendTextBtn.addEventListener('click', sendTextUnified);

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
function metricSeries(m){ return m?.fromPrimary_ms || m?.fromVoiceStart_ms || {}; }
function appendLatencyRow(m){ if(!latHistoryDiv) return; const div=document.createElement('div'); div.className='row'; const fv=metricSeries(m); div.textContent=`#${m.id} ${m.conn||'-'}/${m.kind||'-'} 基准:${m.baseLabel||'-'} 首字:${fmt(fv.text)} 首音频:${fmt(fv.audioDelta)} 播放:${fmt(fv.audioPlay)}`; latHistoryDiv.appendChild(div); latHistoryDiv.scrollTop=latHistoryDiv.scrollHeight; }
function refreshLatencySummary(){ if(!latAvgText || !latAvgAudioDelta || !latAvgAudioPlay || !latCurrentTurn) return; latAvgText.textContent='-'; latAvgAudioDelta.textContent='-'; latAvgAudioPlay.textContent='-';
  let sumT=0,cT=0,sumA=0,cA=0,sumP=0,cP=0; latencyHistory.forEach(m=>{ const fv=metricSeries(m); if(fv.text!=null){ sumT+=fv.text; cT++; } if(fv.audioDelta!=null){ sumA+=fv.audioDelta; cA++; } if(fv.audioPlay!=null){ sumP+=fv.audioPlay; cP++; } });
  if(cT) latAvgText.textContent=(sumT/cT).toFixed(0)+' ms'; if(cA) latAvgAudioDelta.textContent=(sumA/cA).toFixed(0)+' ms'; if(cP) latAvgAudioPlay.textContent=(sumP/cP).toFixed(0)+' ms';
  if(latencyCurrentTurn && !latencyCurrentTurn.metricsEmitted){ const primary=getLatencyPrimaryBase(latencyCurrentTurn); const cur=latencySeries(latencyCurrentTurn, primary.value); latCurrentTurn.textContent=`基准:${primary.label} 首字:${fmt(cur.text)} 首音频:${fmt(cur.audioDelta)} 播放:${fmt(cur.audioPlay)}`; } else { latCurrentTurn.textContent='-'; }
}

btnLatToggle?.addEventListener('click',()=>{ latHistoryDiv.style.display = (latHistoryDiv.style.display==='none')?'':'none'; btnLatToggle.textContent = latHistoryDiv.style.display==='none' ? '展开' : '隐藏'; });
btnLatShow?.addEventListener('click',()=>{ latPanel.style.display=''; btnLatShow.style.display='none'; });
btnLatExport?.addEventListener('click',()=>{ if(!latencyHistory.length){ alert('没有数据'); return; } const header='id,conn,kind,base,text_ms,audio_delta_ms,audio_play_ms,response_created_ms,voice_start_text_ms,voice_start_audio_delta_ms,voice_start_audio_play_ms\n'; const rows=latencyHistory.map(m=>{ const fv=metricSeries(m); const vs=m.fromVoiceStart_ms||{}; return [m.id,m.conn||'',m.kind||'',m.baseLabel||'',fv.text??'',fv.audioDelta??'',fv.audioPlay??'',fv.responseCreated??'',vs.text??'',vs.audioDelta??'',vs.audioPlay??''].join(','); }); const csv=header+rows.join('\n'); const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='latency.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000); });
btnLatClear?.addEventListener('click',()=>{ latencyHistory.length=0; latHistoryDiv.innerHTML=''; refreshLatencySummary(); });
btnLatPin?.addEventListener('click',()=>{ latPinned=!latPinned; btnLatPin.textContent = latPinned? '取消固定':'固定'; if(latPinned){ latPanel.style.opacity='1'; } });

// 初始尝试自动显示面板（无数据则保持隐藏）
setTimeout(()=>{ if(!chkShowLatency || !chkShowLatency.checked){ latPanel.style.display='none'; return; } if(latencyHistory.length===0){ latPanel.style.display=''; } }, 300);

chkShowLatency?.addEventListener('change',()=>{
  if(!chkShowLatency.checked){ latPanel.style.display='none'; }
  else { latPanel.style.display=''; refreshLatencySummary(); }
});


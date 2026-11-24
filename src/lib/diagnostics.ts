// Never return raw SDK errors: they can contain authorization headers, URLs,
// tokens, sender addresses, subjects, or response bodies.
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{};
export function statusCode(error:unknown){
  const e=record(error),response=record(e.response);
  const n=Number(response.status??e.code??e.status);
  return Number.isInteger(n)&&n>=100&&n<=599?n:0;
}
const knownReasons=new Set(['userRateLimitExceeded','rateLimitExceeded','quotaExceeded','dailyLimitExceeded','insufficientPermissions','forbidden','accessNotConfigured','domainPolicy','authError','badRequest','invalidArgument','backendError','notFound','invalid_grant','RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED','SERVICE_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
export function errorReason(error:unknown){
  const response=record(record(error).response),data=record(response.data),provider=record(data.error);
  const reasons=[data.error,provider.status,...(Array.isArray(provider.errors)?provider.errors.map(e=>record(e).reason):[]),...(Array.isArray(provider.details)?provider.details.map(e=>record(e).reason):[])];
  return reasons.find((r):r is string=>typeof r==='string'&&knownReasons.has(r));
}
export function rateLimited(error:unknown){
  return statusCode(error)===429||['userRateLimitExceeded','rateLimitExceeded','quotaExceeded','RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED'].includes(errorReason(error)??'');
}
export function retryAfterMs(error:unknown,now=Date.now()){
  const headers=record(record(error).response).headers;
  const h=record(headers);
  const value=typeof h.get==='function'?(h.get as (key:string)=>unknown).call(headers,'retry-after'):h['retry-after'];
  if(typeof value!=='string'&&typeof value!=='number')return 0;
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
  const at=Date.parse(String(value));return Number.isFinite(at)?Math.max(0,at-now):0;
}
export function scanFailure(error:unknown,phase:'listing'|'metadata',checked:number,total:number){
  const status=statusCode(error),reason=errorReason(error),e=record(error);
  const cause=record(e.cause),networkCode=typeof e.code==='string'?e.code:typeof cause.code==='string'?cause.code:'';
  let code='SCAN_REQUEST_FAILED',description='An unexpected request failed. Please report this diagnostic code.';
  if(rateLimited(error)){code='GMAIL_RATE_LIMIT';description='Gmail temporarily limited requests. Wait at least one minute, then scan again.';}
  else if(status===401||reason==='invalid_grant'){code='GMAIL_AUTH_EXPIRED';description='Gmail authorization expired or was revoked. Reconnect Gmail, then scan again.';}
  else if(reason==='accessNotConfigured'||reason==='SERVICE_DISABLED'){code='GMAIL_API_DISABLED';description='Enable Gmail API in the Google Cloud project for this OAuth client.';}
  else if(reason==='dailyLimitExceeded'){code='GMAIL_DAILY_LIMIT';description='The Google project reached its daily API limit. Check its quota before scanning again.';}
  else if(status===403){code='GMAIL_PERMISSION_DENIED';description='Gmail denied this request. Check Gmail modify permission and any Google Workspace restrictions.';}
  else if(status===400){code='GMAIL_BAD_REQUEST';description='Gmail rejected a scan request. Report this diagnostic code so its parameters can be checked.';}
  else if(status>=500){code='GMAIL_UNAVAILABLE';description='Gmail is temporarily unavailable. Try scanning again later.';}
  else if(['ETIMEDOUT','ECONNRESET','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','ABORT_ERR'].includes(networkCode)){code='GMAIL_CONNECTION_ERROR';description='The connection to Google failed or timed out. Check your connection, then scan again.';}
  else if(['TypeError','RangeError','SyntaxError','ReferenceError'].includes(String(e.name))){code=`SCAN_${String(e.name).replace(/Error$/,'').toUpperCase()}_ERROR`;description='A local processing error interrupted the scan. Report this diagnostic code.';}
  const label=phase==='listing'?'finding message pages':`checking message details (${checked} of ${total} checked)`;
  const diagnostic=[code,status?`HTTP ${status}`:'',reason??''].filter(Boolean).join('; ');
  return `Scan incomplete while ${label}. ${description} [${diagnostic}] Cleanup is disabled.`;
}

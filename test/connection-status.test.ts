import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connectionProblem} from '../src/connection-status.ts';

test('provider failures have short actionable messages and never expose transport dumps',()=>{
 for(const [error,status] of [['HTTP 503','unavailable'],['HTTP 429','rateLimited'],['Unauthorized 401','needsAuth'],['HTTP 403','blocked'],['HTTP 404','unavailable'],['Grok did not answer','unavailable'],['fetch failed','unavailable'],['Streamable HTTP POSTing {"secret":"hidden"}','error'],['Specific setup problem','error']] as const){
  const out=connectionProblem(new Error(error));assert.equal(out.status,status);assert.doesNotMatch(out.message,/hidden|POSTing|\{/);
 }
 assert.equal(connectionProblem(null).status,'error');
 assert.equal(connectionProblem('',{transportFailureReason:'MCP_TRANSPORT_FAILURE_REASON_HTTP_5XX'}).status,'unavailable');
 assert.equal(connectionProblem('Configure your region').message,'Configure your region');
});

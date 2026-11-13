import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pluginVariables} from '../src/connection-manifest.ts';
const source={gitUrl:'https://github.com/example/app.git',gitRef:'a'.repeat(40),gitPath:'.'};
const variables={type:'object',properties:{API_KEY:{type:'string'}},required:['API_KEY']};
const fetcher=(body:any,status=200)=>async()=>new Response(JSON.stringify(body),{status});

test('missing schemas come only from the pinned public manifest, without credentials or code execution',async()=>{
 let requested='';let options:any;
 const found=await pluginVariables(source,async(url,opts)=>{requested=String(url);options=opts;return new Response(JSON.stringify({variables}))});
 assert.deepEqual(found,variables);assert.equal(requested,`https://raw.githubusercontent.com/example/app/${source.gitRef}/.cursor-plugin/plugin.json`);
 assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');
 await pluginVariables({...source,gitPath:'plugins/app'},async(url)=>{assert.match(String(url),/plugins\/app\/\.cursor-plugin/);return new Response('{}')});
});

test('malformed and untrusted source locations never make a request',async()=>{
 for(const override of [{gitUrl:'bad'},{gitUrl:'http://github.com/example/app'},{gitUrl:'https://github.com.evil.test/example/app'},{gitUrl:'https://user:pass@github.com/example/app'},{gitUrl:'https://github.com/example/app?q=x'},{gitUrl:'https://github.com/example/app#x'},{gitUrl:'https://github.com/one'},{gitUrl:'https://github.com/a/b/c'},{gitUrl:'https://github.com/a/b%20c'},{gitRef:'main'},{gitRef:null},{gitPath:'../private'},{gitPath:1},{gitPath:'bad path'}]){
  assert.equal(await pluginVariables({...source,...override},async()=>{assert.fail('unsafe request')}),null);
 }
});

test('absent, invalid, oversized and failed manifests leave backend metadata intact',async()=>{
 for(const value of [{}, {variables:[]},{variables:'bad'},{variables:{}},{variables:{properties:[]}},{variables:{properties:'bad'}}])assert.equal(await pluginVariables(source,fetcher(value)),null);
 assert.equal(await pluginVariables(source,fetcher({},404)),null);
 assert.equal(await pluginVariables(source,async()=>new Response(null)),null);
 assert.equal(await pluginVariables(source,async()=>new Response('invalid JSON')),null);
 assert.equal(await pluginVariables(source,async()=>new Response('x'.repeat(256*1024+1))),null);
 assert.equal(await pluginVariables(source,async()=>{throw new Error('Network unavailable')}),null);
 assert.deepEqual(await pluginVariables({...source,gitPath:undefined},fetcher({variables})),variables);
});

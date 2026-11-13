import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BotFiles} from '../src/bot-files.ts';
const bot={id:'a',agentId:'uuid-a',name:'A'};
function fixture(){let now=0;let file:any={path:'/file',name:'file',sizeBytes:3};let chunk:any={data:'YWJj',totalSize:3};let upload:any={url:'https://upload.test/file',uploadToken:'secret',headers:{'content-type':'text/plain'}};const files=new BotFiles({now:()=>now,rpc:async(method)=>{
 if(method==='ListGrokBotUserStoreFiles')return {files:[file]};if(method==='ReadGrokBotAgentAttachmentChunk')return chunk;if(method==='BeginGrokBotAgentFileUpload')return upload;return {};
 }});return {files,setTime:(v:number)=>{now=v},setFile:(v:any)=>{file=v},setChunk:(v:any)=>{chunk=v},setUpload:(v:any)=>{upload=v}};}
test('file boundary validation rejects malformed paths, lengths, offsets and expired capabilities',async()=>{
 const f=fixture();
 for(const path of [null,0,'','a\0b'])await assert.rejects(f.files.beginDownload(bot,path),/path/);
 for(const size of [-1,1.5,Infinity,'bad',1024*1024*1024+1]){f.setFile({path:'/file',sizeBytes:size});await assert.rejects(f.files.beginDownload(bot,'/file'),/1 GiB/);}
 f.setFile({path:'/file',sizeBytes:3});const download=await f.files.beginDownload(bot,'/file');
 for(const offset of [-1,1.5,'0',4])await assert.rejects(f.files.chunk('a',{id:download.id,offset}),/offset/);
 await assert.rejects(f.files.chunk('a',{id:0,offset:0}),/expired/);
 f.setChunk({data:'INVALID!',totalSize:3});await assert.rejects(f.files.chunk('a',{id:download.id,offset:0}),/invalid data/);
 for(const reply of [{data:'',totalSize:'bad'},{data:'',totalSize:-1},{data:'',totalSize:2**32},{data:Buffer.alloc(128*1024+1).toString('base64'),totalSize:3}]){f.setChunk(reply);await assert.rejects(f.files.chunk('a',{id:download.id,offset:0}),/limits/);}
 f.setTime(31*60_000);await assert.rejects(f.files.chunk('a',{id:download.id,offset:0}),/expired/);
 f.files.close();
});
test('upload validates names, exact size and hash, HTTPS destinations and authorization headers',async()=>{
 const f=fixture();const valid={name:'file.txt',sizeBytes:0,sha256:'a'.repeat(64)};
 for(const name of ['',null,'.','..','a/b','a\\b','a\0b','a'.repeat(256)])await assert.rejects(f.files.beginUpload(bot,{...valid,name}),/file name/);
 for(const sizeBytes of [-1,'0',1.1,2**31])await assert.rejects(f.files.beginUpload(bot,{...valid,sizeBytes}),/1 GiB/);
 for(const sha256 of [null,'abc','g'.repeat(64)])await assert.rejects(f.files.beginUpload(bot,{...valid,sha256}),/checksum/);
 for(const bad of [{url:'http://upload.test',uploadToken:'s'},{url:'https://u:p@upload.test',uploadToken:'s'},{url:'https://upload.test',uploadToken:''},{url:'https://upload.test',uploadToken:1}]){f.setUpload(bad);await assert.rejects(f.files.beginUpload(bot,valid),/unsafe/);}
 for(const headers of [{Authorization:'secret'},{Host:'evil'},{Cookie:'secret'},{'Proxy-Authorization':'secret'},{foo:1}]){f.setUpload({url:'https://upload.test',uploadToken:'s',headers});await assert.rejects(f.files.beginUpload(bot,valid),/headers/);}
 f.setUpload({url:'https://upload.test',uploadToken:'s',finalName:'renamed'});const upload=await f.files.beginUpload(bot,{...valid,contentType:'text/plain'});assert.equal(upload.name,'renamed');
 f.setTime(16*60_000);await assert.rejects(f.files.finishUpload(bot,upload.id),/expired/);f.files.close();
});

test('empty files and malformed chunk bodies stay within their exact transfer size',async()=>{
 const f=fixture();f.setFile({path:'/file'});const file=await f.files.beginDownload(bot,'/file');assert.equal(file.size,0);
 f.setChunk({totalSize:0});assert.deepEqual(await f.files.chunk('a',{id:file.id,offset:0}),{data:'',totalSize:0});
 f.setUpload({url:'https://upload.test/file',uploadToken:'token'});const upload=await f.files.beginUpload(bot,{name:'file',sizeBytes:0,sha256:'a'.repeat(64)});assert.equal(upload.name,'file');f.files.close();
});

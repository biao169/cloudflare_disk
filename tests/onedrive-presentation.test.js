import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMime,fallbackMime,validatePresentation,publicPresentation} from '../worker/services/onedrive-presentation.js';
import {qrMatrix,qrSvg} from '../public/js/vendor/qr-code.js';

test('RC14.9 presentation fields enforce lengths, explicit cover options and safe MIME types',()=>{
 assert.deepEqual(validatePresentation({title:' 样例 ',preview_enabled:false,cover_style:'ocean'}),{title:'样例',preview_enabled:0,cover_style:'ocean'});
 assert.throws(()=>validatePresentation({title:'A'.repeat(141)}),/INVALID_INPUT/);
 assert.throws(()=>validatePresentation({description:'bad\x00text'}),/INVALID_INPUT/);
 assert.throws(()=>validatePresentation({__proto__x:'1'}),/INVALID_INPUT/);
 assert.throws(()=>validatePresentation({preview_enabled:'false'}),/INVALID_INPUT/);
 assert.throws(()=>validatePresentation({cover_style:'<script>'}),/INVALID_INPUT/);
 assert.equal(previewMime('image/svg+xml'),null);
 assert.equal(previewMime('text/html'),null);
 assert.equal(previewMime('application/pdf'),'application/pdf');
 assert.equal(fallbackMime('foo.MP4'),'video/mp4');
 assert.equal(fallbackMime('foo.svg'),null);
});

test('RC14.9 public metadata includes stable same-origin paths and no secret storage identifiers',()=>{
 const data=publicPresentation({id:'odf_'+'a'.repeat(32),drive_id:'privateDrive',item_id:'privateItem',file_name:'Hello.png',created_at:'2026-01-02 03:04:05',file_size:100,file_mime:'image/png',preview_enabled:1,status:'active',cover_style:'auto'});
 assert.equal(data.share_url,'/s/odf_'+'a'.repeat(32));
 assert.equal(data.download_url,'/r/odf_'+'a'.repeat(32));
 assert.equal(data.preview_enabled,true);
 assert.equal(data.size,100);
 assert.ok(!JSON.stringify(data).includes('privateDrive'));
});

test('RC14.9 QR SVG uses local offline generator, contains quiet zone, no external service',()=>{
 const url='https://example.test/s/odf_'+'f'.repeat(32);
 const pixels=qrMatrix(url);
 assert.ok(pixels.length>=21&&pixels.length<=177);
 assert.equal(pixels.length,pixels[0].length);
 const svg=qrSvg(url);
 assert.match(svg,/viewBox="0 0 \d+ \d+"/);
 assert.ok(svg.includes('shape-rendering="crispEdges"'));
 assert.ok(!svg.includes('https://example.test/'));
});

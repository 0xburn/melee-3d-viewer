import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

test('optional audio follows acknowledged seeks, pauses, speed, music and teardown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melee-audio-test-'));
  globalThis.window = new EventTarget();
  globalThis.crossOriginIsolated = true;
  globalThis.__audioPlayers = [];
  const fake = `export class ReplayPlayer extends EventTarget {
    constructor(options) { super(); this.options=options;this.speed=1;this.ready=false;this._videoEpoch=0;this.seeks=[];globalThis.__audioPlayers.push(this); }
    async enableAudio() { this.unlocked=true; }
    async open() { if(globalThis.__audioOpenGate)await globalThis.__audioOpenGate;this.ready=true; }
    seek(frame,options) { this._videoEpoch++;this.seeks.push({frame,...options}); }
    setSpeed(speed) {this.speed=speed;}
    setMusic(music) {this.music=music;}
    destroy() {this.destroyed=true;this.ready=false;}
    ack(epoch=this._videoEpoch) {this.dispatchEvent(new CustomEvent('position',{detail:{videoEpoch:epoch,seeking:false}}));}
  }`;
  globalThis.__MELEE_AUDIO_CONFIG__ = { module: 'data:text/javascript,' + encodeURIComponent(fake), assetsUrl: '/test-assets' };
  try {
    const input = await readFile(new URL('../src/audio.ts', import.meta.url), 'utf8');
    const { code } = await transformWithEsbuild(input, 'audio.ts', { loader: 'ts', target: 'es2022' });
    const file = join(dir, 'audio.mjs');
    await writeFile(file, code.replace(/from ["']solid-js["']/, `from ${JSON.stringify(import.meta.resolve('solid-js'))}`));
    const { sound, soundAvailable, soundState } = await import(pathToFileURL(file).href);
    for (let i=0;i<20&&!soundAvailable();i++) await new Promise(r=>setTimeout(r,0));
    assert(soundAvailable());
    assert.equal(sound.frame(), undefined);
    sound.load(new Blob(['test'])); sound.seek(123); sound.transport(true,123,1);
    await sound.enable(); const p=globalThis.__audioPlayers[0];
    assert.equal(p.options.audioOnly,true); assert(p.unlocked);
    assert.deepEqual(p.seeks.at(-1),{frame:0,resume:true});
    assert.equal(sound.frame(),null); p.audioFrame=12.8;p.ack();assert.equal(sound.frame(),135);
    sound.seek(1000);const old=p._videoEpoch;sound.seek(500);p.ack(old);assert.equal(sound.frame(),null);
    p.ack();p.audioFrame=377;assert.equal(sound.frame(),500);
    sound.transport(false,500,1);assert.equal(p.seeks.at(-1).resume,false);
    sound.transport(true,500,2);assert.equal(p.speed,2);assert.equal(p.seeks.at(-1).resume,true);
    sound.music(false);assert.equal(p.music,false);
    sound.disable();assert(p.destroyed);assert.equal(sound.frame(),undefined);assert.equal(soundState(),'off');
    // A late startup completion cannot resurrect sound after cancellation.
    let finish;globalThis.__audioOpenGate=new Promise(r=>finish=r);
    const opening=sound.enable();sound.disable();finish();await opening;
    assert(globalThis.__audioPlayers[1].destroyed);assert.equal(globalThis.__audioPlayers[1].seeks.length,0);
    assert.equal(soundState(),'off');
  } finally {
    await rm(dir,{recursive:true,force:true});
    delete globalThis.__MELEE_AUDIO_CONFIG__;delete globalThis.__audioPlayers;delete globalThis.__audioOpenGate;
    delete globalThis.window;delete globalThis.crossOriginIsolated;
  }
});

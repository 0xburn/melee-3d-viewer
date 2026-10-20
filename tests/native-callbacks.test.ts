import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {NativeCallbackClock, nativeEffectEvents, outgoingNativeScriptEvents} from '../src/render3d/fx/native-callbacks';
import {EffectBank} from '../src/render3d/fx/bank';
import {EFFECT_FILES} from '../src/render3d/fx/dispatch';
import {FxWorld} from '../src/render3d/fx/world';
import type {ScriptEvent} from '../src/render3d/fx/script';
const commands: ScriptEvent[] = [
  {kind:'cmdVar',frame:0,index:0,value:0},
  {kind:'cmdVar',frame:12,index:0,value:1},
  {kind:'cmdVar',frame:30,index:0,value:2},
];
test('DK and copied punch consume the first nonzero command once, not on every counter loop',()=>{
  for(const [character,ground,air,gfx] of [[3,372,377,0x4c8],[4,458,463,0x4a9]]) {
    const clock=new NativeCallbackClock();
    clock.enter(character,ground);
    const events=nativeEffectEvents(character,ground,commands);
    assert.deepEqual(clock.take(events,11),[]);
    assert.equal(clock.take(events,12)[0]?.gfx,gfx);
    assert.deepEqual(clock.take(events,12),[]);
    assert.deepEqual(clock.take(events,0),[]);
    assert.deepEqual(clock.take(events,30),[]);
    assert.equal(clock.enter(character,air),false);
    assert.deepEqual(clock.take(nativeEffectEvents(character,air,commands),30),[]);
    assert.equal(clock.enter(character,14),true);
    clock.enter(character,ground);
    assert.equal(clock.take(events,12).length,1);
  }
});
test('Blizzard starts from the command on both climbers; Teleport starts on entry',()=>{
  for(const character of [10,11]) {
    const e=nativeEffectEvents(character,357,commands);
    assert.deepEqual(e,[{frame:12,gfx:0x4ec,part:29}]);
  }
  assert.deepEqual(nativeEffectEvents(16,356,commands),[{frame:0,gfx:0x4e8,part:5}]);
  assert.deepEqual(nativeEffectEvents(16,354,commands),[]);
});
test('seek reconstruction consumes past triggers exactly once',()=>{
  const clock=new NativeCallbackClock();clock.enter(3,384);
  const e=nativeEffectEvents(3,384,[]);
  assert.equal(clock.take(e,24).length,1);
  assert.deepEqual(clock.take(e,0),[]);
  const rebuilt=new NativeCallbackClock();rebuilt.enter(3,384);
  assert.deepEqual(rebuilt.take(e,24),e);
});
const assetDir=process.env.MELEE_ASSETS;
test('real effect assets: custom joint callbacks and initial punch animation advance', {skip:!assetDir},()=>{
  const banks=new Map<number,EffectBank>();
  for(const id of [0,5,8,13,39]) {
    const file=EFFECT_FILES[id], b=fs.readFileSync(path.join(assetDir!,file.name));
    banks.set(id,new EffectBank(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),file.table,id));
  }
  const w=new FxWorld(banks.get(0)!,(_,p)=>p,banks);
  const joint=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,10,20,30,1]);
  const ctx={pos:[10,20,30] as [number,number,number],follow:()=>joint,facing:1,angle:0,damage:0,scale:2,owner:null};
  w.spawn(0x4e1,{...ctx,offset:[3,7,9]});
  const mt=w.models.at(-1)!;
  assert.deepEqual(w.modelPlace(mt),[10,34,30]);
  joint[13]=40;
  assert.deepEqual(w.modelPlace(mt),[10,54,30]);
  w.spawn(0x49d,ctx);
  const jab=w.models.at(-1)!, prop=jab.bank.prop(jab.index,0,true)!;
  w.poseModel(jab,prop,4);
  assert.equal(prop.skeleton.trans[5],32);
  w.poseModel(jab,prop,1);
  assert.equal(prop.skeleton.trans[5],26);
  w.poseModel(jab,prop,4);
  assert.equal(prop.skeleton.trans[5],32);
  for(const id of [0x4c8,0x4c9,0x4a9,0x4aa]) {
    w.spawn(id,ctx); assert.equal(w.models.at(-1)?.age,1);
  }
});

test('actual fighter scripts expose each required native callback command', {skip:!assetDir},async()=>{
  const {Fighter,fighterFiles}=await import('../src/render3d/fighter');
  const {motionTableFromDol}=await import('../src/render3d/dol');
  const read=(name:string)=>{const b=fs.readFileSync(path.join(assetDir!,name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  const motion=motionTableFromDol(read('main.dol'));
  for(const [character,states]of [[3,[372,373,377,378]],[4,[458,459,463,464]],[10,[357,358]]] as const){
    const files=fighterFiles(character,0)!;
    const fighter=new Fighter(character,read(files[0]),read(files[1]),read(files[2]),0,motion,'test');
    for(const state of states){
      const events=nativeEffectEvents(character,state,fighter.scriptFor(state));
      assert.equal(events.length,1,`character ${character} state ${state} has a command-driven callback`);
      assert.ok(events[0].frame>=0);
    }
  }
});

test('Teleport end-step flash is retained when the post-frame already shows Lost',()=>{
  const flash: ScriptEvent={kind:'gfx',frame:8,gfx:0x3f4,bone:0,common:false,destroyOnChange:false,offset:[0,6,0],range:[0,0,0]};
  for(const [from,to]of[[353,354],[356,357]]) {
    assert.deepEqual(outgoingNativeScriptEvents(16,from,to,7,1,[flash]),[flash]);
    assert.deepEqual(outgoingNativeScriptEvents(16,from,to,8,1,[flash]),[]);
    assert.deepEqual(outgoingNativeScriptEvents(16,from,87,7,1,[flash]),[]);
  }
});

test('completed animations keep their last queued effect, while interruptions do not invent it',()=>{
  const e: ScriptEvent={kind:'gfx',frame:20,gfx:0x3f4,bone:0,common:false,destroyOnChange:false,offset:[0,0,0],range:[0,0,0]};
  assert.deepEqual(outgoingNativeScriptEvents(3,44,14,19,1,[e],true),[e]);
  assert.deepEqual(outgoingNativeScriptEvents(3,44,87,19,1,[e],false),[]);
  assert.deepEqual(outgoingNativeScriptEvents(3,44,14,20,1,[e],true),[]);
});

test('Cutter preserves its three-piece effect through all phases, then can restart',async()=>{
  const {cutterAnimationFrame}=await import('../src/render3d/fx/native-callbacks');
  const clock=new NativeCallbackClock();
  clock.enter(4,389);
  assert.equal(clock.take(nativeEffectEvents(4,389,[]),0)[0]?.gfx,0x494);
  for(const state of [390,391,388]) {
    assert.equal(clock.enter(4,state),false);
    assert.deepEqual(clock.take(nativeEffectEvents(4,state,[]),0),[]);
  }
  clock.enter(4,14);clock.enter(4,385);
  assert.equal(clock.take(nativeEffectEvents(4,385,[]),0).length,1);
  assert.deepEqual([63,64,65,68,69].map(f=>cutterAnimationFrame(f)),[63,60,61,64,60]);
  assert.deepEqual([90,91,100].map(f=>cutterAnimationFrame(f,90)),[65,66,75]);
});

test('Cutter uses two distinct fighter joints and survives its initial animation length', {skip:!assetDir},()=>{
  const banks=new Map<number,EffectBank>();
  for(const id of [0,5]) {
    const file=EFFECT_FILES[id],b=fs.readFileSync(path.join(assetDir!,file.name));
    banks.set(id,new EffectBank(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),file.table,id));
  }
  const w=new FxWorld(banks.get(0)!,(_,p)=>p,banks);
  const joints=new Map([1,44].map(part=>[part,new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,part,10,0,1])]));
  w.spawn(0x494,{pos:[0,0,0],follow:null,partFollow:p=>joints.get(p)??null,facing:1,angle:0,damage:0,scale:1,owner:'0:0:native',age:90});
  assert.equal(w.models.length,3);
  assert.deepEqual(w.models.map(m=>m.index),[0,1,2]);
  assert.deepEqual(w.models.map(m=>m.life),[Infinity,Infinity,Infinity]);
  assert.equal(w.models[0].under?.()?.[12],44);
  const child=banks.get(5)!.prop(0,0,true)!;
  w.poseModel(w.models[0],child,10);
  const matrix=child.skeleton.world;
  assert.deepEqual(Array.from(matrix.slice(12,15)),[44,10,0]);
  // Identity orientation constraint: the animated root may change scale,
  // but must not rotate its parent's axes a second time.
  for(const index of [1,2,4,6,8,9])assert.ok(Math.abs(matrix[index])<1e-6);

  assert.deepEqual(w.models.slice(1).map(m=>w.modelPlace(m)[0]),[44,1]);
  const pr=banks.get(5)!.prop(1,0,true)!;
  w.poseModel(w.models[1],pr,90);
  assert.ok(Array.from(pr.skeleton.world).every(Number.isFinite));
  w.spawn(0x494,{pos:[0,0,0],follow:null,partFollow:p=>joints.get(p)??null,facing:1,angle:0,damage:0,scale:1,owner:'1:0:native',age:92,cutterRelease:90});
  assert.deepEqual(w.models.slice(-3).map(m=>m.life),[101,101,101]);
});

test('native callback anchors use fp->parts indices, independent of script common-bone lookup', {skip:!assetDir},async()=>{
  const {Fighter}=await import('../src/render3d/fighter');
  const {motionTableFromDol}=await import('../src/render3d/dol');
  const read=(name:string)=>{const b=fs.readFileSync(path.join(assetDir!,name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  const fighter=new Fighter(4,read('PlKb.dat'),read('PlKbAJ.dat'),read('PlKbNr.dat'),0,motionTableFromDol(read('main.dol')),'anchors');
  const banks=new Map<number,EffectBank>();
  for(const id of [0,5]) {const f=EFFECT_FILES[id];banks.set(id,new EffectBank(read(f.name),f.table,id));}
  const w=new FxWorld(banks.get(0)!,()=>-1,banks);
  const world=new Float32Array(60*16);
  for(let i=0;i<60;i++)world.set([1,0,0,0,0,1,0,0,0,0,1,0,i*10,20,0,1],i*16);
  w.step(0,[{key:'0:0',fighter,world,st:{internalCharacterId:4,actionStateId:389,actionStateFrameCounter:1,
    isGrounded:false,isDead:false,facingDirection:1,xPosition:0,yPosition:0,hitlagRemaining:0} as any}]);
  const cutter=w.models.filter(m=>m.cutter);
  assert.equal(cutter.length,3);
  assert.equal(cutter[0].under?.()?.[12],440);
  assert.deepEqual(cutter.slice(1).map(m=>w.modelPlace(m)[0]),[440,10]);
});

test('Fox and Falco up-B fire replaces charge with launch and preserves ground/air transitions',()=>{
  for(const character of [1,22]) {
    const clock=new NativeCallbackClock();clock.enter(character,353);
    assert.deepEqual(clock.take(nativeEffectEvents(character,353,[]),0),[{frame:0,gfx:0x48b,part:1,commonPart:true}]);
    assert.equal(clock.enter(character,354),false);
    assert.deepEqual(clock.take(nativeEffectEvents(character,354,[]),10),[]);
    assert.equal(clock.enter(character,356),true);
    assert.deepEqual(clock.take(nativeEffectEvents(character,356,[]),0),[{frame:0,gfx:0x48c,part:4,commonPart:true}]);
    assert.equal(clock.enter(character,355),false);
    assert.deepEqual(clock.take(nativeEffectEvents(character,355,[]),20),[]);
    assert.equal(clock.enter(character,357),true);
  }
});

test('actual Fox/Falco fire models include launch particles and replace root rotations', {skip:!assetDir},()=>{
  const read=(name:string)=>{const b=fs.readFileSync(path.join(assetDir!,name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  const bank=new EffectBank(read('EfFxData.dat'),'effFoxDataTable',3);
  const common=new EffectBank(read('EfCoData.dat'),'effCommonDataTable',0);
  const w=new FxWorld(common,(_,p)=>p,new Map([[0,common],[3,bank]]));
  (w as any).sts.set('0:0',{actionStateId:356,isGrounded:true,facingDirection:-1,selfInducedAirXSpeed:-2,selfInducedAirYSpeed:3,selfInducedGroundXSpeed:0});
  w.spawn(0x48c,{pos:[0,0,0],follow:null,facing:-1,angle:0,damage:0,scale:1,owner:null,by:'0:0'});
  const m=w.models.at(-1)!;assert.equal(m.index,4);assert.equal(m.bank,bank);assert.equal(m.life,Infinity);
  assert.ok(Math.abs(m.rotZ - (Math.PI/2-Math.atan2(3,2)))<1e-8);
  assert.ok(bank.ptclKeys(4).length>0);
  const p=bank.prop(4,0,true)!;assert.ok(p);
  m.rotZ=0.7;w.poseModel(m,p,5);
  assert.equal(p.skeleton.rot[1],Math.fround(-Math.PI/2));
  assert.equal(p.skeleton.rot[2],Math.fround(0.7));
});

// Both zero-lifetime fire descriptors loop until the fighter ends the move.
test('charging fire outlives its first animation cycle', {skip:!assetDir},()=>{
  const read=(name:string)=>{const b=fs.readFileSync(path.join(assetDir!,name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  const bank=new EffectBank(read('EfFxData.dat'),'effFoxDataTable',3);
  const common=new EffectBank(read('EfCoData.dat'),'effCommonDataTable',0);
  const w=new FxWorld(common,(_,p)=>p,new Map([[0,common],[3,bank]]));
  w.spawn(0x48b,{pos:[0,0,0],follow:null,facing:1,angle:0,damage:0,scale:1,owner:'0:0',by:'0:0'});
  const m=w.models.at(-1)!;
  assert.equal(m.life,Infinity);
  assert.ok(bank.ptclKeys(3).some(k=>k.every===19));
  m.age=38; (w as any).modelParticles(m);
  assert.ok(w.ps.gens.length>0,'a later cycle still emits fire during the charge');
});

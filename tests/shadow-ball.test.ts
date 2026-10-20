import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {isShadowBall, shadowBallScale} from '../src/render3d/shadow-ball';

test('Shadow Ball uses recorded charge for held and launched states, not the state as a size', () => {
  assert.equal(isShadowBall(0x70), true);
  assert.equal(isShadowBall(0x90), true);
  assert.equal(isShadowBall(0x5e), false);
  for (const charge of [0,1,3,7]) {
    const scale = 0.5 + 1.5 * charge / 7;
    assert.equal(shadowBallScale(0, charge, 7, 0.5, 2), scale);
    assert.equal(shadowBallScale(charge + 1, charge, 7, 0.5, 2), scale);
  }
  assert.equal(shadowBallScale(9, 7, 7, 0.5, 2), null);
  assert.equal(shadowBallScale(0, 0, 0, 0.5, 2), null);
});
const assetDir=process.env.MELEE_ASSETS;
test('real Shadow Ball replaces only its first grandchild scale after each pose', {skip:!assetDir}, async () => {
  const {Fighter,fighterFiles}=await import('../src/render3d/fighter');
  const {motionTableFromDol}=await import('../src/render3d/dol');
  const read=(name:string)=>{const b=fs.readFileSync(path.join(assetDir!,name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  const files=fighterFiles(16,0)!;
  const f=new Fighter(16,read(files[0]),read(files[1]),read(files[2]),0,motionTableFromDol(read('main.dol')),'test');
  for (const state of [0,1,8]) {
    const art=f.article(1,state)!;
    assert.ok(art?.special);
    const p=art.prop, sk=p.skeleton;
    const child=sk.parent.findIndex(p=>p===0), joint=sk.parent.findIndex(p=>p===child);
    assert.ok(joint>=0);
    const at=(charge:number)=>{
      p.pose(20,10,20,0,art.scale);
      const root=Array.from(sk.scale.slice(0,3));
      const scale=shadowBallScale(state,charge,f.specialAttr(0),art.special!(0x18),art.special!(0x1c))!;
      const original=Array.from(sk.trans.slice(joint*3,joint*3+3));
      p.setGrandchildScale(scale,state===0 ? f.modelScale : undefined);
      if(state===0) assert.deepEqual(Array.from(sk.trans.slice(joint*3,joint*3+3)),original.map(v=>Math.fround(-v*f.modelScale)));
      assert.deepEqual(Array.from(sk.scale.slice(0,3)),root);
      assert.deepEqual(Array.from(sk.scale.slice(joint*3,joint*3+3)),[Math.fround(scale),Math.fround(scale),Math.fround(scale)]);
      return Array.from(sk.world);
    };
    const full=at(7);at(0);assert.deepEqual(at(7),full);
  }
});

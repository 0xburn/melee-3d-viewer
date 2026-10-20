import test from 'node:test';
import assert from 'node:assert/strict';
import {itemSource} from '../src/render3d/item-source';
const player=(internalCharacterId:number)=>({state:{internalCharacterId}});
test('reflection keeps creator assets and costume, independent of seek order and later transformation',()=>{
  const data={settings:{playerSettings:[{costumeIndex:2},{costumeIndex:1}]},frames:[
    {players:[player(16),player(1)],items:[{spawnId:1,owner:0}]},
    {players:[player(16),player(1)],items:[{spawnId:1,owner:1}]},
    {players:[player(19),player(1)],items:[{spawnId:1,owner:1},{spawnId:2,owner:0}]},
  ]} as any;
  const source=(f:number,i=0)=>itemSource(data,data.frames[f].items[i]);
  assert.deepEqual(source(2),{character:16,costume:2});
  assert.deepEqual(source(0),source(2));
  assert.deepEqual(source(2,1),{character:19,costume:2});
});
test('unowned items do not borrow a nonexistent player; stores are isolated between games',()=>{
  const data={settings:{playerSettings:[]},frames:[{players:[],items:[{spawnId:1,owner:-1}]}]} as any;
  assert.equal(itemSource(data,data.frames[0].items[0]),null);
});

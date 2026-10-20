// Validate dispatch references against local game assets; no asset bytes emitted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {EffectBank} from '../src/render3d/fx/bank';
import {EFFECT_FILES, SPAWNS, type Spawn} from '../src/render3d/fx/dispatch';
const dir = process.argv[2];
if (!dir) throw new Error('Pass the asset directory');
const banks = new Map<number,EffectBank>();
let refs = 0;
function check(s: Spawn, effect: string) {
  if ('all' in s) return s.all.forEach(q=>check(q,effect));
  const id = 'bank' in s ? s.bank ?? 0 : 0;
  let b = banks.get(id);
  if (!b) {
    const file = EFFECT_FILES[id]; assert.ok(file, `effect ${effect} bank ${id}`);
    const data = fs.readFileSync(path.join(dir,file.name));
    b = new EffectBank(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),file.table,id);
    banks.set(id,b);
  }
  if ('g' in s) assert.ok(b.cmds[s.g], `effect ${effect}: bank ${id} generator ${s.g}`);
  else for (const m of 'pieces' in s ? s.pieces : Array.isArray(s.m) ? s.m : [s.m])
    assert.ok(b.models[m]?.joint >= 0, `effect ${effect}: bank ${id} model ${m}`);
  refs++;
}
for (const [effect,spawn] of Object.entries(SPAWNS)) check(spawn, Number(effect).toString(16));
console.log(`Validated ${refs} dispatch references across ${banks.size} asset banks`);

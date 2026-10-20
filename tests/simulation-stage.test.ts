import test from 'node:test';
import assert from 'node:assert/strict';
import {clearSimulationStage, receiveSimulationStage, stageFrame} from '../src/simulation-stage';
test('native heights fill old recordings, survive reverse lookups, and clear on game change',()=>{
  const old={settings:{replayFormatVersion:'3.17.0.0'},frames:[]} as any;
  clearSimulationStage();assert.equal(stageFrame(old,123),undefined);
  receiveSimulationStage([[0,20,28],[1,21,27],[2,NaN,26]]);
  assert.deepEqual(stageFrame(old,124),{fodLeftPlatformHeight:21,fodRightPlatformHeight:27});
  assert.deepEqual(stageFrame(old,123),{fodLeftPlatformHeight:20,fodRightPlatformHeight:28});
  assert.equal(stageFrame(old,125),undefined);
  const recorded={fodLeftPlatformHeight:4,fodRightPlatformHeight:5};
  const recent={settings:{replayFormatVersion:'3.18.0.0'},frames:[] as any[]};recent.frames[123]={stage:recorded};
  assert.equal(stageFrame(recent as any,123),recorded);
  clearSimulationStage();assert.equal(stageFrame(old,123),undefined);
});

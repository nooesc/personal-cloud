import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fleetPollDelay} from '../../web/src/components/fleet/polling.ts';
test('missing old-server poll interval cannot produce zero-delay polling',()=>{
 for(const value of [undefined,null,NaN,Infinity,'10000',0,-1,1,1000])assert.equal(fleetPollDelay(value),10000);
 assert.equal(fleetPollDelay(10000),10000);assert.equal(fleetPollDelay(30000),30000);assert.equal(fleetPollDelay(120000),60000);
});

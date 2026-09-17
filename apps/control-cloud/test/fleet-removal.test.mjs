import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertMachineRemovable} from '../src/fleet.ts';
const machine={id:'server',last_seen:'2020-01-01T00:00:00Z'};
function context(rows={}) {return {store:{list:c=>rows[c]??[],get:(c,id)=>(rows[c]??[]).find(r=>r.id===id)}};}
test('retire last offline coordinator while keeping inventory-only hosts',()=>{
 assert.doesNotThrow(()=>assertMachineRemovable(context({network_nodes:[{id:'server',is_server:true}],machines:[machine,{id:'mac'}],retained_volumes:[{machine_id:'historical'}]}),machine));
});
test('coordinator retains peer and workload protection',()=>{
 for(const rows of [{network_nodes:[{id:'server',is_server:true},{id:'peer'}]},...['services','databases','domains','push_requests'].map(c=>({network_nodes:[{id:'server',is_server:true}],[c]:[{id:'work'}]})),{network_nodes:[{id:'server',is_server:true}],deployments:[{status:'building'}]}])
 assert.throws(()=>assertMachineRemovable(context(rows),machine));
 assert.throws(()=>assertMachineRemovable(context({network_nodes:[{id:'server',is_server:true}]}),{...machine,last_seen:new Date().toISOString()}));
});
test('persistent ownership and explicit placement always prevent removal',()=>{
 for(const rows of [{retained_volumes:[{machine_id:'server'}]},{databases:[{machine_id:'server'}]},{services:[{placement:{machine_id:'server'}}]}]) assert.throws(()=>assertMachineRemovable(context(rows),machine));
});

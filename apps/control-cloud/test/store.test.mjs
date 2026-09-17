import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SqlStore} from '../src/store.ts';

function harness(){
 const db=new DatabaseSync(':memory:'),calls=[];
 const storage={sql:{exec(sql,...args){calls.push({sql,args});const statement=db.prepare(sql);return {toArray:()=>statement.all(...args)};}},transactionSync(fn){db.exec('SAVEPOINT unit');try{const result=fn();db.exec('RELEASE unit');return result;}catch(e){db.exec('ROLLBACK TO unit');db.exec('RELEASE unit');throw e;}}};
 // workerd executes sql.exec eagerly; emulate that for writes/DDL.
 storage.sql.exec=(sql,...args)=>{calls.push({sql,args});const statement=db.prepare(sql);if(!/^SELECT/i.test(sql)){statement.run(...args);return {toArray:()=>[]};}return {toArray:()=>statement.all(...args)};};
 return {store:new SqlStore(storage),db,calls};
}
test('collection reads and latest windows preserve insertion order without scanning history',()=>{
 const {store,db,calls}=harness();
 for(let i=0;i<1000;i++)store.put('samples',String(i),{id:String(i),sampled_at:'2026-09-16T00:00:00.000Z'});
 store.put('events','z',{id:'z'});store.put('events','a',{id:'a'});
 assert.deepEqual(store.select('events',{reverse:true,limit:1}),[{id:'a'}]);
 const query=calls.at(-1);const plan=db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args).map(p=>p.detail).join(' ');
 assert.match(plan,/SEARCH documents USING INDEX documents_collection/);
 assert.doesNotMatch(plan,/SCAN documents/);
 assert.deepEqual(store.list('events'),[{id:'z'},{id:'a'}]);
});
test('command polling reads only uncompleted commands for its machine and keeps lease rules applicable',()=>{
 const {store,db,calls}=harness();
 for(let i=0;i<1000;i++)store.put('commands',String(i),{id:String(i),machine_id:'a',completed_at:'done',expires_at:500,key:'old'});
 store.put('commands','pending',{id:'pending',machine_id:'a',expires_at:500,key:'current'});
 store.put('commands','foreign',{id:'foreign',machine_id:'b',expires_at:500,key:'current'});
 store.put('commands','expired',{id:'expired',machine_id:'a',expires_at:10,key:'other'});
 assert.deepEqual(store.select('commands',{equal:{machine_id:'a',completed_at:null},after:{field:'expires_at',value:100}}).map(r=>r.id),['pending']);
 const query=calls.at(-1),plan=db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args).map(p=>p.detail).join(' ');
 assert.match(plan,/SEARCH documents USING INDEX documents_command_queue/);
 assert.deepEqual(store.select('commands',{equal:{key:'current'}}).map(r=>r.id),['pending','foreign']);
});
test('history filtering and pruning are indexed and leave unrelated records intact',()=>{
 const {store,db,calls}=harness();
 store.put('samples','old',{id:'old',sampled_at:'2026-09-15T00:00:00.000Z'});
 store.put('samples','new',{id:'new',sampled_at:'2026-09-16T00:00:00.000Z'});
 store.put('events','old',{id:'old',created_at:'2026-09-15T00:00:00.000Z'});
 const since='2026-09-15T12:00:00.000Z';
 assert.deepEqual(store.select('samples',{after:{field:'sampled_at',value:since}}).map(r=>r.id),['new']);
 const query=calls.at(-1),plan=db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args).map(p=>p.detail).join(' ');assert.match(plan,/SEARCH documents USING INDEX documents_sample_time/);
 store.prune('samples','sampled_at',since);
 assert.equal(store.get('samples','old'),undefined);assert.ok(store.get('samples','new'));assert.ok(store.get('events','old'));
});

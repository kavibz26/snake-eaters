import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetClient } from '../../js/net/client.js';

// The connection indicator shows the MEDIAN of the last few real pings, so these check that one
// noisy sample cannot swing it and that it is cleared when the lobby session ends.
function feed(net, ms) {
  net._onPong({ c: performance.now() - ms });
}

test('rttMedian ignores a single noisy ping and only ever reflects real measurements', () => {
  const net = new NetClient('');
  assert.equal(net.rttMedian, null, 'no fake number before the first pong');
  for (const ms of [40, 42, 41, 43]) feed(net, ms);
  assert.ok(Math.abs(net.rttMedian - 42) <= 2);
  feed(net, 900); // one huge outlier
  assert.ok(net.rttMedian < 60, `median stays put after one outlier (${Math.round(net.rttMedian)}ms)`);
  assert.equal(net.rttWindow.length, 5, 'only the last 5 samples are kept');
});

test('rttMedian follows a sustained change, and is cleared when the lobby session is cleared', () => {
  const net = new NetClient('');
  for (const ms of [40, 40, 40, 40, 40]) feed(net, ms);
  for (const ms of [300, 310, 320]) feed(net, ms);
  assert.ok(net.rttMedian > 250, 'three consecutive slow pings do move the median');
  net._clearLobbySession();
  assert.equal(net.rttMedian, null);
  assert.equal(net.rtt, null);
});

test('nonsense pong values are ignored', () => {
  const net = new NetClient('');
  net._onPong({ c: 'abc' });
  net._onPong({ c: performance.now() + 5000 }); // "from the future"
  net._onPong({});
  assert.equal(net.rttMedian, null);
});

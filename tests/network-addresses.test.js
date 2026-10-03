import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLanAddresses } from '../src/server/network.js';

const ipv4 = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', ...extra });
const adapter = (Name, HardwareInterface, InterfaceDescription = Name, Status = 'Up') => ({ Name, HardwareInterface, InterfaceDescription, Status });

test('multiple adapters recommend the physical LAN and retain VPNs as separately labelled alternatives', () => {
  const info = describeLanAddresses(3000, {
    interfaces: {
      'Ethernet 4': [ipv4('26.45.156.217')],
      'Ethernet 5': [ipv4('10.32.253.250')],
      WLAN: [ipv4('10.24.33.144')],
    },
    adapters: [adapter('Ethernet 4', false, 'Radmin VPN'), adapter('Ethernet 5', false, 'Virtual adapter'), adapter('WLAN', true)],
  });
  assert.deepEqual(info.addresses, ['http://10.24.33.144:3000']);
  assert.equal(info.candidates[0].recommended, true);
  assert.equal(info.candidates[0].interfaceName, 'WLAN');
  assert.deepEqual(info.candidates.slice(1).map(({ kind, recommended }) => ({ kind, recommended })), [
    { kind: 'virtual', recommended: false }, { kind: 'virtual', recommended: false },
  ]);
});

test('adapter identity, rather than an IP prefix allowlist, decides LAN recommendations', () => {
  const info = describeLanAddresses(45678, {
    interfaces: { WLAN: [ipv4('10.32.253.250')], Ethernet: [ipv4('26.45.156.217')] },
    adapters: [adapter('WLAN', true), adapter('Ethernet', true)],
    localAddress: '::ffff:10.32.253.250',
  });
  assert.equal(info.candidates[0].url, 'http://10.32.253.250:45678');
  assert.equal(info.candidates[0].accessed, true);
  assert.ok(info.candidates.every((candidate) => candidate.recommended));
});

test('inactive, loopback, link-local, invalid, multicast, IPv6 and duplicate addresses are not advertised', () => {
  const info = describeLanAddresses(3000, {
    interfaces: {
      WLAN: [null, ipv4('127.0.0.1'), ipv4('0.0.0.0'), ipv4('169.254.1.2'), ipv4('224.0.0.1'),
        ipv4('255.255.255.255'), ipv4('invalid'), ipv4('::1', { family: 'IPv6' }),
        ipv4('192.168.1.1', { internal: true }), ipv4('192.168.1.2'), ipv4('192.168.1.2')],
      unplugged: [ipv4('10.24.33.144')],
    },
    adapters: [adapter('WLAN', true), adapter('unplugged', true, 'Ethernet', 'Disconnected')],
  });
  assert.deepEqual(info.addresses, ['http://192.168.1.2:3000']);
});

test('advertised addresses respect the actual listening interface and assigned port', () => {
  const options = {
    interfaces: { WLAN: [ipv4('10.24.33.144'), ipv4('192.168.1.2')] },
    adapters: [adapter('WLAN', true)],
  };
  for (const host of ['127.0.0.1', '::1']) {
    assert.deepEqual(describeLanAddresses(50123, { ...options, host }).candidates, []);
  }
  assert.deepEqual(describeLanAddresses(50123, { ...options, host: '10.24.33.144' }).addresses, ['http://10.24.33.144:50123']);
  assert.equal(describeLanAddresses(50123, { ...options, host: '0.0.0.0' }).addresses.length, 2);
});

test('missing adapter metadata still exposes unknown addresses and recognizes named virtual networks', () => {
  const info = describeLanAddresses(3000, {
    interfaces: { 'renamed adapter': [ipv4('10.24.33.144')], 'Radmin VPN': [ipv4('26.45.156.217')] },
  });
  assert.deepEqual(info.addresses, ['http://10.24.33.144:3000']);
  assert.equal(info.candidates[0].kind, 'unknown');
  assert.equal(info.candidates[0].recommended, false);
  assert.equal(info.candidates[1].kind, 'virtual');
});

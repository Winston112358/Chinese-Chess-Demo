import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const virtualAdapter = /vpn|tap|tun|virtual|vethernet|vmware|virtualbox|hyper-v|docker|veth|virbr|vmnet|tailscale|zerotier|radmin|hamachi|wireguard|utun|蓝牙|bluetooth|虚拟/i;
const physicalAdapter = /^(wlan|wi-?fi|ethernet|以太网|无线|eth\d|en\d|enp\d|ens\d|eno\d|wl)/i;

let adapterRead;
async function windowsAdapters() {
  if (process.platform !== 'win32') return [];
  // Share an in-flight query, but read again on refresh so Wi-Fi/VPN changes appear.
  if (!adapterRead) {
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; @(Get-NetAdapter -IncludeHidden | Select-Object Name, InterfaceDescription, Status, HardwareInterface) | ConvertTo-Json -Compress";
    adapterRead = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }).then(({ stdout }) => {
      const adapters = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      return Array.isArray(adapters) ? adapters : adapters ? [adapters] : [];
    }).catch(() => []).finally(() => { adapterRead = undefined; });
  }
  return adapterRead;
}

function usableAddress(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254);
}

function adapterKind(name, adapter) {
  if (virtualAdapter.test(`${name} ${adapter?.InterfaceDescription || ''}`)) return 'virtual';
  if (adapter?.HardwareInterface === true) return 'lan';
  if (adapter?.HardwareInterface === false) return 'virtual';
  // Without OS metadata a generic Windows "Ethernet" may still be a VPN adapter.
  return process.platform !== 'win32' && physicalAdapter.test(name) ? 'lan' : 'unknown';
}

export function describeLanAddresses(port, { interfaces = networkInterfaces(), adapters = [], host = '0.0.0.0', localAddress } = {}) {
  const metadata = new Map(adapters.map((adapter) => [adapter.Name, adapter]));
  const candidates = [];
  const seen = new Set();
  const accessedIp = localAddress?.replace(/^::ffff:/, '');
  for (const [name, addresses] of Object.entries(interfaces)) {
    const adapter = metadata.get(name);
    if (adapter && adapter.Status !== 'Up') continue;
    for (const address of addresses || []) {
      if (!address || address.family !== 'IPv4' || address.internal || !usableAddress(address.address)) continue;
      if (!['0.0.0.0', '::'].includes(host) && address.address !== host) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);
      const kind = adapterKind(name, adapter);
      candidates.push({
        url: `http://${address.address}:${port}`,
        address: address.address,
        interfaceName: name,
        description: adapter?.InterfaceDescription || '',
        netmask: address.netmask,
        kind,
        recommended: kind === 'lan',
        accessed: address.address === accessedIp,
      });
    }
  }
  const priority = { lan: 0, unknown: 1, virtual: 2 };
  candidates.sort((a, b) => priority[a.kind] - priority[b.kind] || Number(b.accessed) - Number(a.accessed) || a.interfaceName.localeCompare(b.interfaceName) || a.address.localeCompare(b.address));
  return {
    // Preserve the original API field for older clients, without VPN recommendations.
    addresses: candidates.filter((candidate) => candidate.kind !== 'virtual').map((candidate) => candidate.url),
    candidates,
    listeningOn: host,
  };
}

export async function lanInfo(port, { host = '0.0.0.0', localAddress } = {}) {
  const adapters = host === '127.0.0.1' || host === '::1' ? [] : await windowsAdapters();
  return describeLanAddresses(port, { adapters, host, localAddress });
}

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const [updaterModule, manifestPath, installerPath, reportPath] = process.argv.slice(2);
assert.ok(updaterModule && manifestPath && installerPath && reportPath,
  'usage: verify-legacy-electron-runtime.cjs <electron-updater> <latest.yml> <installer.exe> <report.json>');

const { NsisUpdater } = require(updaterModule);
const { HttpExecutor, configureRequestOptions, configureRequestUrl } = require(
  path.join(updaterModule, '..', 'builder-util-runtime', 'out', 'httpExecutor'));
class NodeExecutor extends HttpExecutor {
  async download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, {
        destination, options, onCancel, responseHandler: null,
        callback: (error) => error == null ? resolve(destination) : reject(error),
      }, 0);
    });
  }
  createRequest(options, callback) {
    return (options.protocol === 'http:' ? http : https).request(options, callback);
  }
}
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-electron-updater-runtime-'));
const manifest = fs.readFileSync(manifestPath);
const installer = fs.readFileSync(installerPath);
const assetName = path.basename(installerPath);
let manifestRequests = 0;
let installerRequests = 0;

const server = http.createServer((request, response) => {
  const route = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (route === '/latest.yml') {
    manifestRequests += 1;
    response.writeHead(200, { 'content-type': 'text/yaml', 'content-length': manifest.length });
    response.end(manifest);
  } else if (route === `/${assetName}`) {
    installerRequests += 1;
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': installer.length });
    response.end(installer);
  } else {
    response.writeHead(404);
    response.end();
  }
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const configPath = path.join(workspace, 'app-update.yml');
  fs.writeFileSync(configPath, `provider: generic\nurl: ${endpoint}\n`, 'utf8');
  const app = {
    version: '1.3.16', name: 'LabelPilot', isPackaged: true,
    appUpdateConfigPath: configPath, userDataPath: workspace, baseCachePath: workspace,
    quit() {}, onQuit() {}, whenReady() { return Promise.resolve(); },
  };
  const updater = new NsisUpdater(null, app);
  updater.httpExecutor = new NodeExecutor();
  updater.setFeedURL({ provider: 'generic', url: endpoint });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const check = await updater.checkForUpdates();
  assert.equal(check.updateInfo.version, '2.0.0');
  const downloaded = await updater.downloadUpdate();
  assert.equal(downloaded.length, 1);
  const downloadedBytes = fs.readFileSync(downloaded[0]);
  assert.deepEqual(downloadedBytes, installer);
  const report = {
    kind: 'labelpilot-electron-updater-runtime', updaterVersion: '6.8.3',
    fromVersion: app.version, toVersion: check.updateInfo.version,
    manifestRequests, installerRequests, downloadedBytes: downloadedBytes.length,
    sha256: crypto.createHash('sha256').update(downloadedBytes).digest('hex'), passed: true,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`LEGACY_RUNTIME_OK ${JSON.stringify(report)}`);
}

main().finally(() => {
  server.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

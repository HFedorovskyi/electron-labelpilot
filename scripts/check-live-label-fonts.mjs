'use strict';

const port = Number(process.argv[2] || 9337);
const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
const page = pages.find(candidate => candidate.type === 'page');
if (!page) throw new Error('LabelPilot CDP page not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    resolver(message);
});
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});
const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message));
    socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
    }));
});
const expression = `(async () => {
    const bundled = ['Inter', 'Roboto', 'Montserrat', 'Ubuntu'];
    const system = ['Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana'];
    for (const family of bundled) {
        await document.fonts.load('400 16px "' + family + '"');
        await document.fonts.load('700 16px "' + family + '"');
    }
    await document.fonts.ready;
    return {
        status: document.fonts.status,
        bundled: Object.fromEntries(bundled.map(family => [family, document.fonts.check('400 16px "' + family + '"')])),
        system: Object.fromEntries(system.map(family => [family, document.fonts.check('400 16px "' + family + '"')])),
        faces: Array.from(document.fonts).map(face => ({ family: face.family, weight: face.weight, status: face.status })),
    };
})()`;
const response = await evaluate(expression);
socket.close();
const result = response.result.result.value;
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'loaded') process.exitCode = 1;
if (Object.values(result.bundled).some(value => value !== true)) process.exitCode = 1;
if (result.faces.filter(face => face.status === 'loaded').length < 6) process.exitCode = 1;

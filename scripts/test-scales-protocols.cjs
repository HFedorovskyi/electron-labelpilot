// Unit test for scale protocol parsers (pure modules — no electron needed).
const path = require('path');
const { MassaK_100, MassaK_A_TB, MassaK_A_TB_P, MassaK_J } = require(path.join(process.cwd(), 'dist-electron/main/protocols/massak_extended.js'));
const { Shtrih_M } = require(path.join(process.cwd(), 'dist-electron/main/protocols/shtrihm.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  OK   ${name} ${extra}`); }
    else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// MassaK_100: command header + binary parse
const cmd = MassaK_100.getWeightCommand();
check('MassaK_100 cmd header F8 55 CE', cmd[0] === 0xF8 && cmd[1] === 0x55 && cmd[2] === 0xCE);
const pkt = Buffer.from([0xF8, 0x55, 0xCE, 0x07, 0x00, 0x10, 0xD0, 0x07, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
const r100 = MassaK_100.parse(pkt);
check('MassaK_100 parse weight=2.000', r100 && Math.abs(r100.weight - 2.0) < 1e-9, `got ${r100 && r100.weight}`);
check('MassaK_100 parse stable=true', r100 && r100.stable === true);
check('MassaK_100 short packet → null', MassaK_100.parse(Buffer.from([0xF8, 0x55, 0xCE, 0x07])) === null);

// MassaK_A_TB: stable must NOT be always-true anymore (was `|| true`)
const aNoS = MassaK_A_TB.parse(Buffer.from('  + 1.235 kg '));
check('MassaK_A_TB no-S → stable=false', aNoS && aNoS.stable === false, `got ${aNoS && aNoS.stable}`);
check('MassaK_A_TB weight=1.235', aNoS && Math.abs(aNoS.weight - 1.235) < 1e-9);
const aS = MassaK_A_TB.parse(Buffer.from('S + 2.500 kg'));
check('MassaK_A_TB with S → stable=true', aS && aS.stable === true);

// MassaK_A_TB_P: was hardcoded true
const pNoS = MassaK_A_TB_P.parse(Buffer.from('1.000'));
check('MassaK_A_TB_P no-S → stable=false', pNoS && pNoS.stable === false, `got ${pNoS && pNoS.stable}`);

// Shtrih_M: was hardcoded true → now false (defer to software stability)
const sh = Shtrih_M.parse(Buffer.from('3.140'));
check('Shtrih_M → stable=false', sh && sh.stable === false, `got ${sh && sh.stable}`);

// MassaK_J: binary, stable from high bit of status byte
const jStable = MassaK_J.parse(Buffer.from([0x80, 0x00, 0xD0, 0x07, 0x00]));
check('MassaK_J stable bit set → 2.000 stable', jStable && Math.abs(jStable.weight - 2.0) < 1e-9 && jStable.stable === true, `got ${jStable && jStable.weight}/${jStable && jStable.stable}`);
const jUnstable = MassaK_J.parse(Buffer.from([0x00, 0x00, 0xD0, 0x07, 0x00]));
check('MassaK_J stable bit clear → unstable', jUnstable && jUnstable.stable === false);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

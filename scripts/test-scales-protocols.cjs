// Unit test for scale protocol parsers (pure modules — no electron needed).
const path = require('path');
const { MassaK_100, MassaK_A_TB, MassaK_A_TB_P, MassaK_J } = require(path.join(process.cwd(), 'dist-electron/main/protocols/massak_extended.js'));
const { Shtrih_M } = require(path.join(process.cwd(), 'dist-electron/main/protocols/shtrihm.js'));
const { Dibal_Delta } = require(path.join(process.cwd(), 'dist-electron/main/protocols/dibal.js'));
const { AND_Standard } = require(path.join(process.cwd(), 'dist-electron/main/protocols/and_std.js'));
const { Ohaus, Sartorius_SBI, Radwag, Kern, DiniArgeo } = require(path.join(process.cwd(), 'dist-electron/main/protocols/eu_ascii.js'));

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

// MassaK_J renamed but id kept (config compatibility)
check('MassaK_J id kept = massak_j', MassaK_J.id === 'massak_j', `got ${MassaK_J.id}`);
check('MassaK_J name no longer references SimplePacking', !/simplepacking/i.test(MassaK_J.name), `got "${MassaK_J.name}"`);

// Dibal Delta: ASCII "+12.345" → 12.345 kg, stable
const dPos = Dibal_Delta.parse(Buffer.from('+12.345A\r\n'));
check('Dibal_Delta +12.345 → 12.345 kg', dPos && Math.abs(dPos.weight - 12.345) < 1e-9 && dPos.unit === 'kg', `got ${dPos && dPos.weight}`);
const dNeg = Dibal_Delta.parse(Buffer.from('-00.500B\r\n'));
check('Dibal_Delta -00.500 → -0.5 kg', dNeg && Math.abs(dNeg.weight + 0.5) < 1e-9);
check('Dibal_Delta junk → null', Dibal_Delta.parse(Buffer.from('garbage')) === null);
check('Dibal_Delta cmd = D CR LF', (() => { const c = Dibal_Delta.getWeightCommand(); return c[0] === 0x44 && c[1] === 0x0D && c[2] === 0x0A; })());

// A&D Standard: ST/US/OL, grams normalised to kg
const aStable = AND_Standard.parse(Buffer.from('ST,+00123.45 g\r\n'));
check('AND ST grams → kg (0.12345)', aStable && Math.abs(aStable.weight - 0.12345) < 1e-9 && aStable.unit === 'kg' && aStable.stable === true, `got ${aStable && aStable.weight}`);
const aKg = AND_Standard.parse(Buffer.from('ST,+0001.250 kg\r\n'));
check('AND ST kg stays kg (1.250)', aKg && Math.abs(aKg.weight - 1.25) < 1e-9 && aKg.unit === 'kg');
const aUns = AND_Standard.parse(Buffer.from('US,+00010.00 g\r\n'));
check('AND US → stable=false', aUns && aUns.stable === false, `got ${aUns && aUns.stable}`);
check('AND OL (overload) → null', AND_Standard.parse(Buffer.from('OL,+ 9999999  g\r\n')) === null);
check('AND junk → null', AND_Standard.parse(Buffer.from('no frame here')) === null);

// OHAUS: ASCII number+unit, grams→kg
const oh = Ohaus.parse(Buffer.from('   1.234 kg\r\n'));
check('OHAUS 1.234 kg', oh && Math.abs(oh.weight - 1.234) < 1e-9 && oh.unit === 'kg', `got ${oh && oh.weight}`);
const ohG = Ohaus.parse(Buffer.from('  250.00 g\r\n'));
check('OHAUS 250.00 g → 0.25 kg', ohG && Math.abs(ohG.weight - 0.25) < 1e-9 && ohG.unit === 'kg', `got ${ohG && ohG.weight}`);
check('OHAUS junk → null', Ohaus.parse(Buffer.from('ERR')) === null);

// Sartorius SBI: signed value + unit
const sa = Sartorius_SBI.parse(Buffer.from('+   123.45 g\r\n'));
check('Sartorius +123.45 g → 0.12345 kg', sa && Math.abs(sa.weight - 0.12345) < 1e-9, `got ${sa && sa.weight}`);
check('Sartorius ESC P cmd', (() => { const c = Sartorius_SBI.getWeightCommand(); return c[0] === 0x1B && c[1] === 0x50; })());

// RADWAG
const rw = Radwag.parse(Buffer.from('SI ?     2.500 kg\r\n'));
check('RADWAG 2.500 kg', rw && Math.abs(rw.weight - 2.5) < 1e-9 && rw.unit === 'kg', `got ${rw && rw.weight}`);

// KERN
const kn = Kern.parse(Buffer.from('     0.512 kg\r\n'));
check('KERN 0.512 kg', kn && Math.abs(kn.weight - 0.512) < 1e-9);

// Dini Argeo: short string ST,GS,weight,unit (decimal in data)
const di = DiniArgeo.parse(Buffer.from('ST,GS,000000.50,kg\r\n'));
check('Dini ST,GS,000000.50,kg → 0.5 kg stable', di && Math.abs(di.weight - 0.5) < 1e-9 && di.stable === true, `got ${di && di.weight}/${di && di.stable}`);
const diUs = DiniArgeo.parse(Buffer.from('US,GS,00000050,kg\r\n'));
check('Dini deci=0 "00000050" → 50 kg, unstable', diUs && Math.abs(diUs.weight - 50) < 1e-9 && diUs.stable === false, `got ${diUs && diUs.weight}/${diUs && diUs.stable}`);
check('Dini OL (overload) → null', DiniArgeo.parse(Buffer.from('OL,GS,00000000,kg\r\n')) === null);
check('Dini extended "ST,1,..." not matched by short parser → null', DiniArgeo.parse(Buffer.from('ST,1,  0.500,GS, 0.000,kg\r\n')) === null);
check('Dini cmd = READ', DiniArgeo.getWeightCommand().toString().trim() === 'READ');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

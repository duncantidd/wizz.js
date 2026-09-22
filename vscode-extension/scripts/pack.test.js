'use strict';

// Tests for the .vsix packer. The packer's zip writer is verified by an
// independent parser in this file — a round trip that reused the writer's
// own offsets would only prove the writer agrees with itself, so the parser
// here walks the central directory from the end-of-central-directory record
// the way an unzipping consumer does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const {
  pack,
  crc32,
  escapeXml,
  buildContentTypes,
  buildVsixManifest,
  validateMetadata,
  PACKAGED_FILES
} = require('./pack.js');

const PACKAGED_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(PACKAGED_ROOT, '..');

function scratchDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Reads a zip the way a consumer does: locate the EOCD record from the tail,
// then walk its central directory entries.
function readCentralDirectory(buffer) {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.compare(eocdSignature, 0, 4, i, i + 4) === 0) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'the package must carry an end-of-central-directory record');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  let position = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, 'central directory records must carry their signature');
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);

    // Cross-check the local header this record points at: flags must be
    // clear (no data descriptors) and both headers must agree on the
    // method, CRC, and sizes.
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'local headers must carry their signature');
    assert.equal(buffer.readUInt16LE(localOffset + 6), 0, 'entries must not rely on data descriptors');
    assert.equal(buffer.readUInt16LE(localOffset + 8), method, 'local and central method values must agree');
    assert.equal(buffer.readUInt32LE(localOffset + 14), crc, 'local and central CRCs must agree');
    assert.equal(buffer.readUInt32LE(localOffset + 18), compressedSize, 'local and central compressed sizes must agree');
    assert.equal(buffer.readUInt32LE(localOffset + 22), uncompressedSize, 'local and central uncompressed sizes must agree');

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
    position += 46 + nameLength;
  }
  return entries;
}

function inflateEntry(buffer, entry) {
  if (entry.method === 0) return buffer.subarray(entry.localOffset + 30 + entry.name.length, entry.localOffset + 30 + entry.name.length + entry.compressedSize);
  const compressed = buffer.subarray(entry.localOffset + 30 + entry.name.length, entry.localOffset + 30 + entry.name.length + entry.compressedSize);
  return zlib.inflateRawSync(compressed);
}

test('crc32 matches the IEEE reflected check vectors', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('a', 'utf8')), 0xE8B7BE43);
});

test('the package validates required metadata and names the offending field', () => {
  const valid = {
    name: 'wizz-vscode',
    displayName: 'Wizz',
    version: '0.1.0',
    publisher: 'wizzjs',
    description: 'Language support for Wizz.',
    engines: { vscode: '^1.85.0' },
    categories: ['Programming Languages']
  };
  assert.doesNotThrow(() => validateMetadata(valid));

  const broken = [
    ['publisher', { ...valid, publisher: 123 }],
    ['version', { ...valid, version: '1.0' }],
    ['engines.vscode', { ...valid, engines: { vscode: '1.85' } }],
    ['displayName', { ...valid, displayName: '' }]
  ];
  for (const [field, metadata] of broken) {
    assert.throws(() => validateMetadata(metadata), (error) => error.message.includes(field),
      `a broken ${field} must be refused by name`);
  }
});

test('derived manifest fields are XML-escaped', () => {
  const manifest = buildVsixManifest({
    name: 'wizz-vscode',
    displayName: 'Wizz',
    version: '0.1.0',
    publisher: 'wizzjs',
    description: 'Parts & pieces <b>bold</b> "quoted"',
    engines: { vscode: '^1.85.0' },
    categories: ['Programming Languages', 'Linters']
  });
  assert.match(manifest, /Parts &amp; pieces &lt;b&gt;bold&lt;\/b&gt; &quot;quoted&quot;/);
  assert.doesNotMatch(manifest, /<b>bold<\/b>/);
  assert.doesNotMatch(manifest, /Parts & pieces/);
  assert.equal(escapeXml('<&>"\''), '&lt;&amp;&gt;&quot;&apos;');
});

test('the content types declare the manifest, the license, and the shipped extensions', () => {
  const contentTypes = buildContentTypes();
  assert.match(contentTypes, /<Default Extension="json" ContentType="application\/json"\/>/);
  assert.match(contentTypes, /<Default Extension="js" ContentType="text\/javascript"\/>/);
  assert.match(contentTypes, /<Override PartName="\/extension\.vsixmanifest" ContentType="application\/xml"\/>/);
  assert.match(contentTypes, /<Override PartName="\/extension\/LICENSE" ContentType="text\/plain"\/>/);
});

test('packing produces the whitelisted surface and nothing else', (t) => {
  const outDirectory = scratchDirectory(t, 'wizz-vsix-surface-');
  const result = pack({ outDirectory });
  const packageBuffer = fs.readFileSync(result.filePath);
  const entries = readCentralDirectory(packageBuffer);

  const expected = [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    ...PACKAGED_FILES.map((member) => `extension/${member}`),
    'extension/LICENSE'
  ];
  assert.deepEqual(entries.map((entry) => entry.name), expected);

  // Repository-only surfaces must never leak into the package.
  const names = entries.map((entry) => entry.name);
  for (const denied of ['extension/test/', 'extension/.vscode/', 'extension/scripts/']) {
    assert.equal(names.some((name) => name.startsWith(denied)), false, `the package must not contain ${denied}`);
  }
  assert.equal(names.some((name) => name.endsWith('.test.js')), false);
});

test('every entry inflates to its source bytes with a matching CRC', (t) => {
  const outDirectory = scratchDirectory(t, 'wizz-vsix-roundtrip-');
  const result = pack({ outDirectory });
  const packageBuffer = fs.readFileSync(result.filePath);

  for (const entry of readCentralDirectory(packageBuffer)) {
    const data = inflateEntry(packageBuffer, entry);
    assert.equal(crc32(data), entry.crc, `the CRC for ${entry.name} must match the central directory`);
    assert.equal(data.length, entry.uncompressedSize, `${entry.name} must inflate to its recorded size`);
    if (entry.name === 'extension/LICENSE') {
      const source = fs.readFileSync(path.join(REPOSITORY_ROOT, 'LICENSE'));
      assert.equal(data.equals(source), true, 'the packaged LICENSE must be the repository MIT license');
    } else if (entry.name.startsWith('extension/')) {
      const source = fs.readFileSync(path.join(PACKAGED_ROOT, entry.name.slice('extension/'.length)));
      assert.equal(data.equals(source), true, `${entry.name} must package its source byte for byte`);
    }
  }
});

test('the package carries the OPC-required members in order', (t) => {
  const outDirectory = scratchDirectory(t, 'wizz-vsix-opc-');
  const result = pack({ outDirectory });
  const entries = readCentralDirectory(fs.readFileSync(result.filePath));
  assert.equal(entries[0].name, '[Content_Types].xml');
  for (const required of ['extension.vsixmanifest', 'extension/package.json', 'extension/extension.js', 'extension/syntaxes/wizz.tmLanguage.json', 'extension/LICENSE']) {
    assert.equal(entries.some((entry) => entry.name === required), true, `the package must contain ${required}`);
  }
});

test('the vsix manifest carries identity, engine, and asset properties', (t) => {
  const outDirectory = scratchDirectory(t, 'wizz-vsix-manifest-');
  const result = pack({ outDirectory });
  const packageBuffer = fs.readFileSync(result.filePath);
  const manifest = inflateEntry(packageBuffer, readCentralDirectory(packageBuffer).find((entry) => entry.name === 'extension.vsixmanifest')).toString('utf8');

  assert.match(manifest, /<PackageManifest Version="2\.0\.0" xmlns="http:\/\/schemas\.microsoft\.com\/developer\/vsx-schema\/2011">/);
  assert.match(manifest, /<Identity Language="en-US" Id="wizz-vscode" Version="0\.1\.0" Publisher="wizzjs"\/>/);
  assert.match(manifest, /<DisplayName>Wizz<\/DisplayName>/);
  assert.match(manifest, /<Property Id="Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.85\.0"\/>/);
  assert.match(manifest, /<Property Id="Microsoft\.VisualStudio\.Code\.ExtensionKind" Value="workspace"\/>/);
  assert.match(manifest, /<Asset Type="Microsoft\.VisualStudio\.Code\.Manifest" Path="extension\/package\.json" Addressable="true"\/>/);
  assert.match(manifest, /<Categories>Programming Languages,Linters<\/Categories>/);
  assert.match(manifest, /<GalleryFlags>Public<\/GalleryFlags>/);
});

test('packing is deterministic', (t) => {
  const first = pack({ outDirectory: scratchDirectory(t, 'wizz-vsix-det-a-') });
  const second = pack({ outDirectory: scratchDirectory(t, 'wizz-vsix-det-b-') });
  assert.equal(
    fs.readFileSync(first.filePath).equals(fs.readFileSync(second.filePath)),
    true,
    'two runs over the same inputs must produce identical bytes'
  );
});

test('packing refuses an existing target instead of clobbering it', (t) => {
  const outDirectory = scratchDirectory(t, 'wizz-vsix-refuse-');
  const result = pack({ outDirectory });
  const sentinel = Buffer.from('sentinel');
  fs.writeFileSync(result.filePath, sentinel);

  assert.throws(() => pack({ outDirectory }), (error) => error.message.includes(result.filePath));
  assert.equal(fs.readFileSync(result.filePath).equals(sentinel), true, 'the existing file must be left untouched');
});

test('packing refuses a missing whitelisted file', (t) => {
  const fixtureRoot = scratchDirectory(t, 'wizz-vsix-missing-');
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
    name: 'fixture',
    displayName: 'Fixture',
    version: '1.0.0',
    publisher: 'fixture',
    description: 'A fixture.',
    engines: { vscode: '^1.85.0' },
    categories: []
  }));
  // Validation runs before any member is read, so no other files are needed
  // to make the missing-member error reachable.
  assert.throws(() => pack({ root: fixtureRoot, outDirectory: path.join(fixtureRoot, 'out') }),
    (error) => error.message.includes('extension.js'));
});

test('the package passes VS Code-side zip validation when unzip is available', (t) => {
  const outDirectory = scratchDirectory(t, 'wizz-vsix-unzip-');
  const result = pack({ outDirectory });
  const probe = spawnSync('unzip', ['-t', result.filePath], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    t.skip('unzip is not on PATH');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
});
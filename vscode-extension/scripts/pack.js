'use strict';

// Packages the VS Code extension as a .vsix with zero dependencies: a .vsix
// is an OPC package, which is a ZIP container with two required members
// ([Content_Types].xml and extension.vsixmanifest) beside the extension/
// payload. The zip writer below is hand-rolled on node:zlib because the
// zero-dependency mandate rules out @vscode/vsce, and every manifest field
// derived from package.json passes escapeXml — repository inputs are still
// treated as untrusted data on their way into XML.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PACKAGED_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(PACKAGED_ROOT, '..');

// The shipped surface is an explicit whitelist, mirroring the packaging
// test's allowlist style: test/, .vscode/, and this scripts/ directory are
// repository-only and must never leak into the package.
const PACKAGED_FILES = [
  'package.json',
  'extension.js',
  'services.js',
  'language-configuration.json',
  'syntaxes/wizz.tmLanguage.json',
  'README.md'
];

// The OPC package requires every part to be typed. Defaults cover the
// extensioned members; the two unusual parts get Overrides — including the
// extensionless LICENSE, which an OPC consumer could not type otherwise.
const CONTENT_TYPES = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="js" ContentType="text/javascript"/>',
  '  <Default Extension="json" ContentType="application/json"/>',
  '  <Default Extension="md" ContentType="text/markdown"/>',
  '  <Default Extension="vsixmanifest" ContentType="text/xml"/>',
  '  <Override PartName="/extension.vsixmanifest" ContentType="application/xml"/>',
  '  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>',
  '</Types>',
  ''
].join('\n');

// ---- CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) ---------------
// The 256-entry table costs 2048 iterations once at module load and zero
// per-call setup afterwards.
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- deterministic timestamps ---------------------------------------------
// Every entry carries the DOS epoch minimum (1980-01-01 00:00) instead of a
// filesystem mtime so two runs on the same inputs produce identical bytes.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildVsixManifest(pkg) {
  // PackageManifest 2.0.0 is the manifest shape VS Code's installer reads:
  // the Identity decides the installed extension id (publisher.name), the
  // Engine property decides whether it loads, and the single Manifest asset
  // points the installer at extension/package.json.
  const engine = pkg.engines && pkg.engines.vscode;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(pkg.publisher)}"/>`,
    `    <DisplayName>${escapeXml(pkg.displayName)}</DisplayName>`,
    `    <Description xml:space="preserve">${escapeXml(pkg.description)}</Description>`,
    `    <Categories>${pkg.categories.map(escapeXml).join(',')}</Categories>`,
    '    <GalleryFlags>Public</GalleryFlags>',
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(engine)}"/>`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>',
    '      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>',
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
    '  </Installation>',
    '  <Dependencies/>',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>',
    '  </Assets>',
    '</PackageManifest>',
    ''
  ].join('\n');
}

function validateMetadata(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('package.json must be a parsed object');
  if (typeof pkg.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(pkg.name)) {
    throw new Error(`package.json field "name" must be a lowercase identifier, got ${JSON.stringify(pkg.name)}`);
  }
  if (typeof pkg.displayName !== 'string' || pkg.displayName.length === 0) {
    throw new Error('package.json field "displayName" must be a non-empty string');
  }
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`package.json field "version" must be a semantic version like 1.0.0, got ${JSON.stringify(pkg.version)}`);
  }
  if (typeof pkg.publisher !== 'string' || !/^[A-Za-z0-9-]+$/.test(pkg.publisher)) {
    throw new Error(`package.json field "publisher" must be an identifier, got ${JSON.stringify(pkg.publisher)}`);
  }
  if (typeof pkg.description !== 'string') {
    throw new Error('package.json field "description" must be a string');
  }
  const engine = pkg.engines && pkg.engines.vscode;
  if (typeof engine !== 'string' || !/^\^\d+\.\d+\.\d+$/.test(engine)) {
    throw new Error(`package.json field "engines.vscode" must be a caret range like ^1.85.0, got ${JSON.stringify(engine)}`);
  }
  if (!Array.isArray(pkg.categories)) {
    throw new Error('package.json field "categories" must be an array');
  }
}

// The external-attributes field is the unix mode in its upper 16 bits.
// Written as a multiplication — `0o100644 << 16` is a negative int32 in
// JavaScript and writeUInt32LE rejects it.
const UNIX_REGULAR_FILE_MODE = 0o100644 * 0x10000;

function createZip(entries) {
  // Entries are compressed before any header is emitted, so CRC and sizes
  // are final: the general-purpose flag stays clear and neither header needs
  // a data descriptor. Deflate is used only when it is strictly shorter;
  // otherwise the entry is stored (method 0) with identical method values in
  // both headers.
  const localParts = [];
  const directoryParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const compressed = deflated.length < data.length ? deflated : data;
    const method = compressed === data ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general-purpose flags: no data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBuffer.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix, spec 2.0
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0, 8); // general-purpose flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(UNIX_REGULAR_FILE_MODE, 38);
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuffer.copy(central, 46);

    localParts.push(local, compressed);
    directoryParts.push(central);

    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central directory disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // central directory offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, directory, end]);
}

function pack(options = {}) {
  const root = options.root ?? PACKAGED_ROOT;
  const manifestPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateMetadata(pkg);

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: 'extension.vsixmanifest', data: Buffer.from(buildVsixManifest(pkg), 'utf8') }
  ];
  for (const member of PACKAGED_FILES) {
    const source = path.join(root, member);
    let data;
    try {
      data = fs.readFileSync(source);
    } catch (error) {
      throw new Error(`the packaged surface is missing ${member} (${error.message})`);
    }
    entries.push({ name: `extension/${member}`, data });
  }
  // The extension surface is validated first so a missing member is reported
  // even when the repository license is also absent.
  const licensePath = path.resolve(root, '..', 'LICENSE');
  entries.push({ name: 'extension/LICENSE', data: fs.readFileSync(licensePath) });

  const fileName = `${pkg.name}-${pkg.version}.vsix`;
  const outDirectory = path.resolve(options.outDirectory ?? path.join(REPOSITORY_ROOT, 'release'));
  fs.mkdirSync(outDirectory, { recursive: true });

  const filePath = path.join(outDirectory, fileName);
  if (fs.existsSync(filePath)) {
    // The release flow's release/ directory already carries the framework
    // tarball when this step runs; only the vsix file itself must not exist.
    throw new Error(`refusing to overwrite an existing package: ${filePath}`);
  }

  const zip = createZip(entries);
  fs.writeFileSync(filePath, zip);
  return {
    fileName,
    filePath,
    bytes: zip.length,
    entries: entries.map((entry) => entry.name)
  };
}

module.exports = {
  pack,
  crc32,
  escapeXml,
  buildContentTypes: () => CONTENT_TYPES,
  buildVsixManifest,
  validateMetadata,
  PACKAGED_FILES
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let outDirectory;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--out' && args[i + 1]) {
      outDirectory = args[i + 1];
    } else {
      process.stderr.write('Usage: node vscode-extension/scripts/pack.js --out <directory>\n');
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode === undefined) {
    try {
      const result = pack({ outDirectory });
      process.stdout.write(`Wrote ${result.filePath} (${result.bytes} bytes)\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
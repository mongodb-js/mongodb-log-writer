import { MongoLogWriter, MongoLogManager, MongoLogEntry, mongoLogId } from '../';
import { EJSON, ObjectId } from 'bson';
import { once } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import stream from 'stream';
import { gunzip, constants as zlibConstants } from 'zlib';
import { promisify, inspect } from 'util';
import sinon from 'ts-sinon';
import chai, { expect } from 'chai';
import sinonChai from 'sinon-chai';
chai.use(sinonChai);

describe('MongoLogWriter', () => {
  it('allows writing log messages to a stream', async() => {
    const now = new Date(1628591965386);
    const target = new stream.PassThrough().setEncoding('utf8');
    const writer = new MongoLogWriter('logid', null, target, () => now);
    const logEvents: MongoLogEntry[] = [];
    writer.on('log', entry => logEvents.push(entry));
    expect(writer.target).to.equal(target);
    writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.warn('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.error('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.fatal('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.debug('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' }, 2);
    writer.write({
      t: now,
      s: 'E',
      c: 'x',
      id: mongoLogId(0),
      ctx: 'y',
      msg: 'z'
    });
    await writer.flush();
    const log = target.read()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
    expect(log).to.deep.equal(EJSON.serialize(logEvents));
    expect(log).to.deep.equal([
      {
        t: { $date: '2021-08-10T10:39:25.386Z' },
        s: 'I',
        c: 'component',
        id: 12345,
        ctx: 'context',
        msg: 'message',
        attr: { foo: 'bar' }
      },
      {
        t: { $date: '2021-08-10T10:39:25.386Z' },
        s: 'W',
        c: 'component',
        id: 12345,
        ctx: 'context',
        msg: 'message',
        attr: { foo: 'bar' }
      },
      {
        t: { $date: '2021-08-10T10:39:25.386Z' },
        s: 'E',
        c: 'component',
        id: 12345,
        ctx: 'context',
        msg: 'message',
        attr: { foo: 'bar' }
      },
      {
        t: { $date: '2021-08-10T10:39:25.386Z' },
        s: 'F',
        c: 'component',
        id: 12345,
        ctx: 'context',
        msg: 'message',
        attr: { foo: 'bar' }
      },
      {
        t: { $date: '2021-08-10T10:39:25.386Z' },
        s: 'D2',
        c: 'component',
        id: 12345,
        ctx: 'context',
        msg: 'message',
        attr: { foo: 'bar' }
      },
      {
        t: { $date: '2021-08-10T10:39:25.386Z' },
        s: 'E',
        c: 'x',
        id: 0,
        ctx: 'y',
        msg: 'z'
      }
    ]);
  });

  it('can log error object as data as-is', async() => {
    const now = new Date(1628591965386);
    const target = new stream.PassThrough().setEncoding('utf8');
    const writer = new MongoLogWriter('logid', null, target, () => now);
    writer.error('component', mongoLogId(12345), 'context', 'message', new Error('foo'));
    await writer.flush();
    const log = target.read()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
    log[0].attr.stack = '';
    expect(log[0].attr).to.deep.equal({
      code: null,
      message: 'foo',
      name: 'Error',
      stack: ''
    });
  });

  it('can log non-trivial data', async() => {
    const now = new Date(1628591965386);
    const target = new stream.PassThrough().setEncoding('utf8');
    const writer = new MongoLogWriter('logid', null, target, () => now);

    const cyclic: any = {};
    cyclic.cyclic = cyclic;
    writer.error('component', mongoLogId(12345), 'context', 'message', cyclic);

    await writer.flush();
    const log = target.read()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line).attr);
    expect(log).to.deep.equal([{
      _inspected: inspect(cyclic)
    }]);
  });

  it('rejects invalid messages', async() => {
    const errors: Error[] = [];
    function tryWrite(input: any) {
      const target = new stream.PassThrough().setEncoding('utf8');
      const writer = new MongoLogWriter('logid', null, target);
      writer.on('error', (err) => errors.push(err));
      writer.write(input);
    }
    tryWrite({});
    tryWrite({ s: 'E' });
    tryWrite({ s: 'E', c: '' });
    tryWrite({ s: 'E', c: '', id: mongoLogId(0) });
    tryWrite({ s: 'E', c: '', id: mongoLogId(0), ctx: '' });
    tryWrite({ s: 'E', c: '', id: mongoLogId(0), ctx: '', msg: '' });

    await new Promise(setImmediate);
    expect(errors).to.have.lengthOf(5);
    expect(new Set([...errors.map(err => err.name)])).to.deep.equal(new Set(['TypeError']));
  });
});

describe('MongoLogManager', () => {
  let directory: string;
  let onwarn: any;
  let onerror: any;
  let retentionDays: number;

  beforeEach(async() => {
    retentionDays = 30;
    onwarn = sinon.stub();
    onerror = sinon.stub();
    directory = path.join(os.tmpdir(), `log-writer-test-${Math.random()}-${Date.now()}`);
    await fs.mkdir(directory, { recursive: true });
  });
  afterEach(async() => {
    await fs.rmdir(directory, { recursive: true });
  });

  it('allows creating and writing to log files', async() => {
    const manager = new MongoLogManager({
      directory, retentionDays, onwarn, onerror
    });

    const writer = await manager.createLogWriter();
    expect(path.relative(directory, writer.logFilePath as string)[0]).to.not.equal('.');
    expect((writer.logFilePath as string).includes(writer.logId)).to.equal(true);

    writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.end();
    await once(writer, 'finish');

    const log = (await fs.readFile(writer.logFilePath as string, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    expect(log).to.have.lengthOf(1);
    expect(log[0].t.$date).to.be.a('string');
  });

  it('cleans up old log files when requested', async() => {
    retentionDays = 0.000001; // 86.4 ms
    const manager = new MongoLogManager({
      directory, retentionDays, onwarn, onerror
    });

    const writer = await manager.createLogWriter();
    writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.end();
    await once(writer, 'finish');

    await fs.stat(writer.logFilePath as string);
    await new Promise(resolve => setTimeout(resolve, 100));
    await manager.cleanupOldLogfiles();
    try {
      await fs.stat(writer.logFilePath as string);
      expect.fail('missed exception');
    } catch (err: any) {
      expect(err.code).to.equal('ENOENT');
    }
  });

  it('cleans up least recent log files when requested', async() => {
    const manager = new MongoLogManager({
      directory, retentionDays, maxLogFileCount: 5, onwarn, onerror
    });

    const paths: string[] = [];
    const offset = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      const filename = path.join(directory, ObjectId.createFromTime(offset - i).toHexString() + '_log');
      await fs.writeFile(filename, '');
      paths.unshift(filename);
    }

    const getFiles = async() => {
      return (await Promise.all(paths.map(path => fs.stat(path).then(() => 1, () => 0)))).join('');
    };
    expect(await getFiles()).to.equal('1111111111');
    await manager.cleanupOldLogfiles();
    expect(await getFiles()).to.equal('0000011111');
  });

  it('cleaning up old log files is a no-op by default', async() => {
    const manager = new MongoLogManager({
      directory: path.join('directory', 'nonexistent'), retentionDays, onwarn, onerror
    });

    await manager.cleanupOldLogfiles();
  });

  it('creates no-op write streams as a fallback', async() => {
    const manager = new MongoLogManager({
      directory: path.join('directory', 'nonexistent'), retentionDays, onwarn, onerror
    });

    const writer = await manager.createLogWriter();
    expect(onwarn).to.have.been.calledOnce; // eslint-disable-line
    expect(writer.logFilePath).to.equal(null);

    writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.end();
    await once(writer, 'finish');
  });

  it('optionally allow gzip’ed log files', async() => {
    const manager = new MongoLogManager({
      directory, retentionDays, onwarn, onerror, gzip: true
    });

    const writer = await manager.createLogWriter();
    expect(writer.logFilePath as string).to.match(/\.gz$/);
    writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    writer.end();
    await once(writer, 'log-finish');

    const log = (await promisify(gunzip)(await fs.readFile(writer.logFilePath as string)))
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
    expect(log).to.have.lengthOf(1);
    expect(log[0].t.$date).to.be.a('string');
  });

  it('optionally can read truncated gzip’ed log files', async() => {
    const manager = new MongoLogManager({
      directory, retentionDays, onwarn, onerror, gzip: true
    });

    const writer = await manager.createLogWriter();
    expect(writer.logFilePath as string).to.match(/\.gz$/);
    writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
    await writer.flush();

    const log = (await promisify(gunzip)(await fs.readFile(writer.logFilePath as string), { finishFlush: zlibConstants.Z_SYNC_FLUSH }))
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
    expect(log).to.have.lengthOf(1);
    expect(log[0].t.$date).to.be.a('string');

    // Still clean up here because Windows doesn’t like open files:
    writer.end();
    await once(writer, 'finish');
  });
});

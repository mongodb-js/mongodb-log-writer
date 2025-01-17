> [!WARNING] 
> **mongodb-log-writer** has been changed to **[@mongodb-js/mongodb-log-writer](https://www.npmjs.com/package/@mongodb-js/mongodb-log-writer)** and is now being maintained in the [devtools-shared](https://github.com/mongodb-js/devtools-shared/) repository. Please check there for updates.

# mongodb-log-writer

A library for writing MongoDB logv2 messages.

```js
import { MongoLogManager, mongoLogId } from 'mongodb-log-writer';

const manager = new MongoLogManager({
  directory: os.homedir() + '/.app-logs',
  retentionDays: 30,
  onwarn: console.warn,
  onerror: console.error,
  gzip: true
});
await manager.cleanupOldLogfiles();

const writer = manager.createLogWriter();
writer.info('component', mongoLogId(12345), 'context', 'message', { foo: 'bar' });
```

## LICENSE

Apache-2.0

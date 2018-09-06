module.exports = require('yargs')
    .usage('Usage: $0 [options]')
    .describe('v', 'possible values: "error", "warn", "info", "debug"')
    .describe('n', 'instance name. used as topic prefix')
    .describe('k', 'allow ssl connections without valid certificate')
    .describe('u', 'mqtt broker url')
    .describe('p', 'gateway password')
    .describe('d', 'json file with sid to name mappings')
    .describe('h', 'show help')
    .alias({
        h: 'help',
        n: 'name',
        u: 'url',
        k: 'insecure',
        v: 'verbosity',
        p: 'password',
        d: 'devices'
    })
    .default({
        u: 'mqtt://127.0.0.1',
        n: 'aqara',
        v: 'info'
    })
    .boolean('k')
    .version()
    .help('help')
    .argv;

#!/usr/bin/env node

/* eslint-disable no-case-declarations */

const log = require('yalm');
const Mqtt = require('mqtt');
const Aqara = require('lumi-aqara');
const mw = require('mqtt-wildcard');

const config = require('./config.js');
const pkg = require('./package.json');

process.title = pkg.name;

log.setLevel(config.verbosity);

log.info(pkg.name + ' ' + pkg.version + ' starting');

const aqara = new Aqara();
let mqttConnected;
let gatewayConnected = 0;
const gwVol = {};
const gwDevices = {};
const gwPasswords = {};
const batLevel = {};

const names = {};
const sids = {};
if (config.devices) {
    const devices = require(config.devices);
    Object.keys(devices).forEach(sid => {
        if (typeof devices[sid] === 'object') {
            names[sid] = devices[sid].name;
            gwPasswords[sid] = devices[sid].password;
        } else {
            names[sid] = devices[sid];
        }
        sids[names[sid]] = sid;
    });
}

log.info('mqtt trying to connect', config.url.replace(/:[^@/]+@/, '@'));
const mqtt = Mqtt.connect(config.url, {
    will: {topic: config.name + '/connected', payload: '0', retain: true},
    rejectUnauthorized: !config.insecure
});

function mqttPub(topic, payload, options) {
    if (typeof payload !== 'string') {
        payload = JSON.stringify(payload);
    }
    log.debug('mqtt >', topic, payload);
    mqtt.publish(topic, payload, options);
}

mqtt.on('connect', () => {
    mqttConnected = true;

    log.info('mqtt connected', config.url.replace(/:[^@/]+@/, '@'));
    pubConnected();

    log.info('mqtt subscribe', config.name + '/set/+/+');
    mqtt.subscribe(config.name + '/set/+/+');
});

mqtt.on('close', () => {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.url.replace(/:[^@/]+@/, '@'));
    }
});

mqtt.on('error', err => {
    log.error('mqtt', err);
});

mqtt.on('message', (topic, payload) => {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);
    const match = mw(topic, config.name + '/set/+/+');

    const [name, cmd] = match;
    const sid = sids[name] || name;

    if (!aqara._gateways.has(sid)) {
        log.warn('unknown gateway', sid);
        return;
    }
    const gw = aqara._gateways.get(sid);
    switch (cmd) {
        case 'bri':
            let bri = parseInt(payload, 10) || 0;
            if (bri > 100) {
                bri = 100;
            }
            gw.setIntensity(bri);
            break;
        case 'color':
            const col = payload.replace('#', '');
            const [, ...rgb] = col.match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
            const [r, g, b] = rgb.map(v => parseInt(v, 16));
            gw.setColor({r, g, b});
            break;
        case 'volume':
            let vol = parseInt(payload, 10) || 0;
            if (vol > 100) {
                vol = 100;
            }
            gwVol[sid] = vol;
            break;

        case 'sound':
            const index = parseInt(payload, 10);
            if (index) {
                gw.setSound(index, gwVol[sid] || 1);
            }
            break;

        default:
            log.warn('invalid set topic', topic);
    }
});

function pubConnected() {
    mqttPub(config.name + '/connected', gatewayConnected ? '2' : '1', {retain: true});
}

function getName(sid) {
    return names[sid] || sid;
}

function pubBattery(topic, device) {
    const sid = device.getSid();
    const batVoltage = device.getBatteryVoltage && (device.getBatteryVoltage() / 1000);
    if (batVoltage !== batLevel[sid]) {
        batLevel[sid] = batVoltage;
        const batPercent = device.getBatteryPercentage && device.getBatteryPercentage();
        const payload = {
            val: batPercent,
            voltage: batVoltage,
            low: batVoltage < 2.8,
            ts: (new Date()).getTime(),
            aqara: {
                type: device.getType(),
                sid
            }
        };
        mqttPub(topic + '/battery', payload, {retain: true});
    }
}

function createPayload(val, device, addition) {
    addition = addition || {};
    return Object.assign(addition, { // eslint-disable-line no-return-assign
        val,
        ts: (new Date()).getTime(),
        aqara: {
            type: device.getType(),
            sid: device.getSid()
        }
    });
}

aqara.on('gateway', gateway => {
    log.info('gateway discovered', gateway._sid, gateway._ip, getName(gateway._sid));
    gateway.on('ready', () => {
        log.info('gateway ready', gateway._sid, getName(gateway._sid));
        if (gwPasswords[gateway._sid]) {
            gateway.setPassword(gwPasswords[gateway._sid]);
        }
        gatewayConnected += 1;
        pubConnected();
        const topic = config.name + '/status/' + getName(gateway._sid);
        mqttPub(topic + '/offline', {val: false, ts: (new Date()).getTime(), aqara: {sid: gateway._sid, ip: gateway._ip}}, {retain: true});
    });

    gateway.on('offline', () => {
        gatewayConnected -= 1;
        pubConnected();
        log.warn('gateway offline', gateway._sid, getName(gateway._sid));
        const topic = config.name + '/status/' + getName(gateway._sid);
        mqttPub(topic + '/offline', {val: true, ts: (new Date()).getTime(), aqara: {sid: gateway._sid, ip: gateway._ip}}, {retain: true});
    });

    gateway.on('subdevice', device => {
        if (!gwDevices[gateway._sid]) {
            gwDevices[gateway._sid] = [];
        }
        if (!gwDevices[gateway._sid].includes(device.getSid())) {
            log.info('got device', device.getSid(), device.getType(), names[device.getSid()], device._offline);
            gwDevices[gateway._sid].push(device.getSid());
        }

        const topic = config.name + '/status/' + getName(device.getSid());

        device.on('online', () => {
            mqttPub(topic + '/offline', {val: false, ts: (new Date()).getTime()}, {retain: true});
            pubBattery(topic, device);
        });

        device.on('offline', () => {
            mqttPub(topic + '/offline', {val: true, ts: (new Date()).getTime()}, {retain: true});
        });

        switch (device.getType()) {
            case 'magnet': {
                mqttPub(topic + '/magnet', createPayload(Boolean(device.isOpen()), device), {retain: true});
                pubBattery(topic, device);
                device.on('open', () => {
                    mqttPub(topic + '/magnet', createPayload(device.isOpen(), device), {retain: true});
                    pubBattery(topic, device);
                });
                device.on('close', () => {
                    mqttPub(topic + '/magnet', createPayload(device.isOpen(), device), {retain: true});
                    pubBattery(topic, device);
                });
                break;
            }

            case 'switch': {
                device.on('click', () => {
                    mqttPub(topic + '/press', createPayload(true, device));
                    pubBattery(topic, device);
                });
                device.on('doubleClick', () => {
                    mqttPub(topic + '/press_double', createPayload(true, device));
                    pubBattery(topic, device);
                });
                device.on('longClickPress', () => {
                    mqttPub(topic + '/press_long', createPayload(true, device));
                    pubBattery(topic, device);
                });
                device.on('longClickRelease', () => {
                    mqttPub(topic + '/press_long_release', createPayload(true, device));
                    pubBattery(topic, device);
                });
                break;
            }

            case 'motion': {
                mqttPub(topic + '/motion', createPayload(Boolean(device.hasMotion()), device), {retain: true});
                mqttPub(topic + '/brightness', createPayload(device.getLux(), device), {retain: true});
                pubBattery(topic, device);
                device.on('motion', () => {
                    mqttPub(topic + '/motion', createPayload(device.hasMotion(), device), {retain: true});
                    mqttPub(topic + '/brightness', createPayload(device.getLux(), device), {retain: true});
                    pubBattery(topic, device);
                });
                device.on('noMotion', () => {
                    mqttPub(topic + '/motion', createPayload(device.hasMotion(), device, {elapsed: device.getSecondsSinceMotion()}), {retain: true});
                    mqttPub(topic + '/brightness', createPayload(device.getLux(), device), {retain: true});
                    pubBattery(topic, device);
                });
                break;
            }

            case 'sensor': {
                device.on('update', () => {
                    const temp = device.getTemperature();
                    const hum = device.getHumidity();
                    const pres = device.getPressure();
                    mqttPub(topic + '/temperature', createPayload(temp, device), {retain: true});
                    mqttPub(topic + '/humidity', createPayload(hum, device), {retain: true});
                    if (pres) {
                        mqttPub(topic + '/pressure', createPayload(pres, device), {retain: true});
                    }
                    pubBattery(topic, device);
                });
                break;
            }

            case 'leak': {
                mqttPub(topic + '/leak', createPayload(Boolean(device.isLeaking()), device), {retain: true});
                pubBattery(topic, device);
                device.on('update', () => {
                    mqttPub(topic + '/leak', createPayload(device.isLeaking(), device), {retain: true});
                    pubBattery(topic, device);
                });
                break;
            }

            case 'cube': {
                device.on('update', () => {
                    const status = device.getStatus();
                    const degree = device.getRotateDegrees();
                    if (degree) {
                        mqttPub(topic + '/rotate', createPayload(Math.round(parseFloat(degree.split(',')[0]) * 3.6), device, {time: parseFloat(degree.split(',')[1])}));
                        pubBattery(topic, device);
                    } else {
                        mqttPub(topic + '/' + status, createPayload(true, device));
                        pubBattery(topic, device);
                    }
                });
                break;
            }

            case 'smoke': {
                mqttPub(topic + '/smoke', createPayload(Boolean(device.hasAlarm()), device, {density: device.getDensity()}), {retain: true});
                pubBattery(topic, device);
                device.on('update', () => {
                    mqttPub(topic + '/smoke', createPayload(device.hasAlarm(), device), {density: device.getDensity()}, {retain: true});
                    pubBattery(topic, device);
                });
                break;
            }

            case 'vibration': {
                device.on('update', () => {
                    const coord = device.getCoordination() && device.getCoordination().split(',').map(v => parseInt(v, 10));
                    const bed = parseInt(device.getBedActivity(), 10);
                    if (coord) {
                        mqttPub(topic + '/coordination', createPayload(coord, device), {retain: true});
                        mqttPub(topic + '/coordination/x', coord[0], {retain: true});
                        mqttPub(topic + '/coordination/y', coord[1], {retain: true});
                        mqttPub(topic + '/coordination/z', coord[2], {retain: true});
                    }
                    if (bed) {
                        mqttPub(topic + '/bed_activity', createPayload(bed, device), {retain: true});
                    }
                    pubBattery(topic, device);
                });
                device.on('vibrate', () => {
                    mqttPub(topic + '/vibration', createPayload(true, device));
                    pubBattery(topic, device);
                });
                device.on('freeFall', () => {
                    mqttPub(topic + '/free_fall', createPayload(true, device));
                    pubBattery(topic, device);
                });
                device.on('tilt', () => {
                    mqttPub(topic + '/tilt', createPayload(parseInt(device.getFinalTiltAngel(), 10), device));
                    pubBattery(topic, device);
                });
                break;
            }

            default:
        }
    });

    gateway.on('lightState', state => {
        const bri = state.intensity;
        const r = ('0' + state.color.r.toString(16)).slice(-2);
        const g = ('0' + state.color.g.toString(16)).slice(-2);
        const b = ('0' + state.color.b.toString(16)).slice(-2);
        mqttPub(config.name + '/status/' + getName(gateway._sid) + '/bri', {val: bri, ts: (new Date()).getTime(), aqara: {sid: gateway._sid, ip: gateway._ip}}, {retain: true});
        mqttPub(config.name + '/status/' + getName(gateway._sid) + '/color', {val: '#' + r + g + b, ts: (new Date()).getTime(), aqara: {sid: gateway._sid, ip: gateway._ip}}, {retain: true});
    });
});

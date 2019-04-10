// @flow

import fs from 'fs';
import path from 'path';

import { tankerUrl } from '../../../../packages/functional-tests/src/Helpers';
import { fromBase64, toBase64 } from '../../../../packages/client-node';


const password = 'plop';

class BaseUser {
  _tanker: any;
  _id: string;

  constructor(tanker, id) {
    this._tanker = tanker;
    this._id = id;
  }

  async encrypt(message, userIds, groupIds) {
    return toBase64(await this._tanker.encrypt(message, { shareWithUsers: userIds, shareWithGroups: groupIds }));
  }

  async decrypt(encryptedData) {
    return this._tanker.decrypt(fromBase64(encryptedData));
  }

  async createGroup(ids) {
    return this._tanker.createGroup(ids);
  }

  async revokeDevice(deviceId) {
    return this._tanker.revokeDevice(deviceId);
  }

  get id() {
    return this._id;
  }

  get deviceId() {
    return this._tanker.deviceId;
  }

  getRevocationPromise () {
    return new Promise(resolve => this._tanker.once('revoked', resolve));
  }
}

class UserV1 extends BaseUser {
  _token: string;

  constructor(tanker, id, token) {
    super(tanker, id);
    this._token = token;
  }

  async open() {
    await this._tanker.open(this._id, this._token);
  }

  async create() {
    await this.open();
    if (!await this._tanker.hasRegisteredUnlockMethods()) {
      await this._tanker.registerUnlock({ password });
    }
  }

  async close() {
    await this._tanker.close();
  }

  get token() {
    return this._token;
  }
}

class UserV2 extends BaseUser {
  _identity: string;

  constructor(tanker, id, identity) {
    super(tanker, id);
    this._identity = identity;
  }

  async signIn() {
    await this._tanker.signIn(this._identity, { password });
  }

  async signOut() {
    await this._tanker.signOut();
  }

  get identity() {
    return this._identity;
  }
}

function makeTanker(Tanker, userId, trustchainId, prefix) {
  const dbPath = path.join('/tmp', `${prefix}${userId}${trustchainId.replace(/[/\\]/g, '_')}/`);
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath);
  }
  return new Tanker({
    trustchainId,
    url: tankerUrl,
    sdkType: 'test',
    dataStore: {
      dbPath,
    },
  });
}

export function makeV1User(Tanker, userId, token, trustchainId, prefix = 'default') {
  const tanker = makeTanker(Tanker, userId, trustchainId, prefix);
  tanker.on('unlockRequired', async () => {
    await tanker.unlockCurrentDevice({ password });
  });
  return new UserV1(tanker, userId, token);
}

export function makeCurrentUser(userId, identity, trustchainId, prefix = 'default') {
  const Tanker = require('../../../../packages/client-node').default; // eslint-disable-line global-require
  const tanker = makeTanker(Tanker, userId, trustchainId, prefix);
  return new UserV2(tanker, userId, identity);
}

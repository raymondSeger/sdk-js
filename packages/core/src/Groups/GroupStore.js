// @flow

import varint from 'varint';
import { tcrypto, utils, type b64string } from '@tanker/crypto';
import { errors as dbErrors, type DataStore } from '@tanker/datastore-base';
import { type Group, type ExternalGroup } from './types';
import { getStaticArray, unserializeGeneric } from '../Blocks/Serialize';
import * as EncryptorV2 from '../DataProtection/Encryptors/v2';

type EncryptedPrivateKeys = {|
  signatureKey: Uint8Array,
  encryptionKey: Uint8Array,
|};

type DbGroup = {|
  _id: b64string,
  publicSignatureKey: b64string,
  publicEncryptionKey: b64string,
  encryptedPrivateKeys: ?Uint8Array,
  encryptedPrivateSignatureKey: ?b64string,
  lastGroupBlock: b64string,
  index: number,
|};

function encryptGroupKeys(userSecret: Uint8Array, group: Group): Uint8Array {
  const ad = utils.concatArrays(
    group.groupId,
    group.signatureKeyPair.publicKey,
    group.encryptionKeyPair.publicKey,
    group.lastGroupBlock,
    new Uint8Array(varint.encode(group.index)),
  );
  const data = utils.concatArrays(group.signatureKeyPair.privateKey, group.encryptionKeyPair.privateKey);
  return EncryptorV2.encrypt(userSecret, data, ad);
}

async function decryptGroupKeys(userSecret: Uint8Array, dbGroup: DbGroup): Promise<EncryptedPrivateKeys> {
  if (!dbGroup.encryptedPrivateKeys)
    throw new Error('Group not fullgroup');

  const ad = utils.concatArrays(
    utils.fromBase64(dbGroup._id), // eslint-disable-line no-underscore-dangle
    utils.fromBase64(dbGroup.publicSignatureKey),
    utils.fromBase64(dbGroup.publicEncryptionKey),
    utils.fromBase64(dbGroup.lastGroupBlock),
    new Uint8Array(varint.encode(dbGroup.index)),
  );

  // $FlowIKnow already checked for nullity
  const ec = EncryptorV2.decrypt(userSecret, dbGroup.encryptedPrivateKeys, ad);
  return unserializeGeneric(ec, [
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PRIVATE_KEY_SIZE, o, 'signatureKey'),
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PRIVATE_KEY_SIZE, o, 'encryptionKey'),
  ]);
}


function groupToDbGroup(userSecret: Uint8Array, group: Group): DbGroup {
  const dbGroup = {
    _id: utils.toBase64(group.groupId),
    publicSignatureKey: utils.toBase64(group.signatureKeyPair.publicKey),
    publicEncryptionKey: utils.toBase64(group.encryptionKeyPair.publicKey),
    encryptedPrivateSignatureKey: null,
    lastGroupBlock: utils.toBase64(group.lastGroupBlock),
    index: group.index,
  };
  const encryptedPrivateKeys = encryptGroupKeys(userSecret, group);
  return { ...dbGroup, encryptedPrivateKeys };
}

function externalGroupToDbGroup(group: ExternalGroup): DbGroup {
  if (!group.encryptedPrivateSignatureKey)
    throw new Error('Assertion error: trying to add external group without encrypted private signature key');

  return {
    _id: utils.toBase64(group.groupId),
    publicSignatureKey: utils.toBase64(group.publicSignatureKey),
    publicEncryptionKey: utils.toBase64(group.publicEncryptionKey),
    encryptedPrivateKeys: null,
    // $FlowIKnow already checked for nullity
    encryptedPrivateSignatureKey: utils.toBase64(group.encryptedPrivateSignatureKey),
    lastGroupBlock: utils.toBase64(group.lastGroupBlock),
    index: group.index,
  };
}

async function dbGroupToGroup(userSecret: Uint8Array, dbGroup: DbGroup): Promise<Group> {
  if (!dbGroup.encryptedPrivateKeys)
    throw new Error(`no private key found for group ${dbGroup.publicSignatureKey}`);

  const encryptedPrivateKeys = await decryptGroupKeys(userSecret, dbGroup);
  return {
    groupId: utils.fromBase64(dbGroup._id), // eslint-disable-line no-underscore-dangle,
    signatureKeyPair: {
      publicKey: utils.fromBase64(dbGroup.publicSignatureKey),
      privateKey: encryptedPrivateKeys.signatureKey,
    },
    encryptionKeyPair: {
      publicKey: utils.fromBase64(dbGroup.publicEncryptionKey),
      privateKey: encryptedPrivateKeys.encryptionKey,
    },
    lastGroupBlock: utils.fromBase64(dbGroup.lastGroupBlock),
    index: dbGroup.index,
  };
}

function dbGroupToExternalGroup(group: DbGroup): ExternalGroup {
  return {
    groupId: utils.fromBase64(group._id), // eslint-disable-line no-underscore-dangle
    publicSignatureKey: utils.fromBase64(group.publicSignatureKey),
    publicEncryptionKey: utils.fromBase64(group.publicEncryptionKey),
    encryptedPrivateSignatureKey: group.encryptedPrivateSignatureKey ? utils.fromBase64(group.encryptedPrivateSignatureKey) : null,
    lastGroupBlock: utils.fromBase64(group.lastGroupBlock),
    index: group.index,
  };
}

const GROUPS_TABLE = 'groups';

const schemaV3 = {
  tables: [{
    name: GROUPS_TABLE,
    indexes: [['publicEncryptionKey']],
  }]
};

export default class GroupStore {
  _ds: DataStore<*>;
  _userSecret: Uint8Array;

  static schemas = [
    // this store didn't exist in schema version 1 and 2
    { version: 1, tables: [] },
    { version: 2, tables: [] },
    {
      version: 3,
      ...schemaV3
    },
    {
      version: 4,
      ...schemaV3
    },
    {
      version: 5,
      ...schemaV3
    },
    {
      version: 6,
      ...schemaV3
    },
  ];

  constructor(ds: DataStore<*>, userSecret: Uint8Array) {
    if (!userSecret)
      throw new Error('Invalid user secret');

    // _ properties won't be enumerable, nor reconfigurable
    Object.defineProperty(this, '_ds', { value: ds, writable: true });
    Object.defineProperty(this, '_userSecret', { value: userSecret }); // + not writable
  }

  static async open(ds: DataStore<*>, userSecret: Uint8Array): Promise<GroupStore> {
    return new GroupStore(ds, userSecret);
  }

  async close(): Promise<void> {
    // $FlowIKnow
    this._ds = null;
  }

  async updateLastGroupBlock(args: { groupId: Uint8Array, currentLastGroupBlock: Uint8Array, currentLastGroupIndex: number }): Promise<void> {
    const record = await this._findDbGroup(args.groupId);
    if (!record)
      throw new Error(`updateLastGroupBlock: could not find group ${utils.toBase64(args.groupId)}`);
    if (record.encryptedPrivateKeys) {
      const group = await dbGroupToGroup(this._userSecret, record);
      group.lastGroupBlock = args.currentLastGroupBlock;
      group.index = args.currentLastGroupIndex;
      await this._ds.put(GROUPS_TABLE, groupToDbGroup(this._userSecret, group));
    } else {
      record.lastGroupBlock = utils.toBase64(args.currentLastGroupBlock);
      record.index = args.currentLastGroupIndex;
      await this._ds.put(GROUPS_TABLE, record);
    }
  }

  async putExternal(group: ExternalGroup): Promise<void> {
    await this._ds.put(GROUPS_TABLE, externalGroupToDbGroup(group));
  }

  async put(group: Group): Promise<void> {
    return this._ds.put(GROUPS_TABLE, groupToDbGroup(this._userSecret, group));
  }

  async _findDbGroup(groupId: Uint8Array): Promise<?DbGroup> {
    try {
      return await this._ds.get(GROUPS_TABLE, utils.toBase64(groupId));
    } catch (e) {
      if (!(e instanceof dbErrors.RecordNotFound)) {
        throw e;
      }
    }
    return null;
  }

  findFull = async (args: { groupId?: Uint8Array, groupPublicEncryptionKey?: Uint8Array }): Promise<?Group> => {
    const { groupId, groupPublicEncryptionKey } = args;
    if (Object.keys(args).length !== 1)
      throw new Error(`findFull: expected exactly one argument, got ${Object.keys(args).length}`);

    let record;
    if (groupId) {
      record = await this._findDbGroup(groupId);
    } else if (groupPublicEncryptionKey) {
      record = await this._ds.first(GROUPS_TABLE, { selector: { publicEncryptionKey: utils.toBase64(groupPublicEncryptionKey) } });
    } else
      throw new Error('Assertion failed: findFull: both selectors are null');

    if (!record || !record.encryptedPrivateKeys)
      return null;
    return dbGroupToGroup(this._userSecret, record);
  }

  findExternal = async (args: { groupId?: Uint8Array, groupPublicEncryptionKey?: Uint8Array }): Promise<?ExternalGroup> => {
    const { groupId, groupPublicEncryptionKey } = args;
    if (Object.keys(args).length !== 1)
      throw new Error(`findExternal: expected exactly one argument, got ${Object.keys(args).length}`);

    if (groupId) {
      const record = await this._findDbGroup(groupId);
      if (!record)
        return null;
      return dbGroupToExternalGroup(record);
    } else if (groupPublicEncryptionKey) {
      const record = await this._ds.first(GROUPS_TABLE, { selector: { publicEncryptionKey: utils.toBase64(groupPublicEncryptionKey) } });
      if (record)
        return dbGroupToExternalGroup(record);
    } else
      throw new Error('findExternal: invalid argument');
    return null;
  }
}

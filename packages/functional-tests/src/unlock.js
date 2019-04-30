// @flow
import uuid from 'uuid';
import { Tanker, errors } from '@tanker/core';

import { expect } from './chai';
import { type TestArgs } from './TestArgs';

const expectUnlock = async (tanker, identity, signInOptions) => {
  const signInResult = await tanker.signIn(identity, signInOptions);
  expect(tanker.isOpen).to.be.true;
  expect(signInResult).to.equal(Tanker.signInResult.OK);
};

const generateUnlockTests = (args: TestArgs) => {
  describe('unlock', () => {
    let bobLaptop;
    let bobPhone;
    let bobIdentity;
    let trustchainHelper;

    before(() => {
      ({ bobLaptop, bobPhone, trustchainHelper } = args);
    });

    beforeEach(async () => {
      const bobId = uuid.v4();
      bobIdentity = await trustchainHelper.generateIdentity(bobId);
      await bobLaptop.signUp(bobIdentity);
    });

    afterEach(async () => {
      await Promise.all([
        bobLaptop.signOut(),
        bobPhone.signOut(),
      ]);
    });

    describe('method registration', () => {
      it('can test that no unlock method has been registered', async () => {
        expect(bobLaptop.hasRegisteredUnlockMethods()).to.be.false;
        expect(bobLaptop.hasRegisteredUnlockMethod('password')).to.be.false;
        expect(bobLaptop.hasRegisteredUnlockMethod('email')).to.be.false;
        expect(bobLaptop.registeredUnlockMethods).to.be.an('array').that.is.empty;
      });

      it('can test that password unlock method has been registered', async () => {
        await expect(bobLaptop.registerUnlock({ password: 'my pass' })).to.be.fulfilled;
        expect(bobLaptop.hasRegisteredUnlockMethods()).to.be.true;
        expect(bobLaptop.hasRegisteredUnlockMethod('password')).to.be.true;
        expect(bobLaptop.hasRegisteredUnlockMethod('email')).to.be.false;
        expect(bobLaptop.registeredUnlockMethods).to.deep.have.members([{ type: 'password' }]);
      });

      it('can test that email unlock method has been registered', async () => {
        await expect(bobLaptop.registerUnlock({ email: 'john@doe.com' })).to.be.fulfilled;
        expect(bobLaptop.hasRegisteredUnlockMethods()).to.be.true;
        expect(bobLaptop.hasRegisteredUnlockMethod('password')).to.be.false;
        expect(bobLaptop.hasRegisteredUnlockMethod('email')).to.be.true;
        expect(bobLaptop.registeredUnlockMethods).to.deep.have.members([{ type: 'email' }]);
      });

      it('can test that both unlock methods have been registered', async () => {
        await expect(bobLaptop.registerUnlock({ password: 'my password', email: 'john@doe.com' })).to.be.fulfilled;
        expect(bobLaptop.hasRegisteredUnlockMethods()).to.be.true;
        expect(bobLaptop.hasRegisteredUnlockMethod('password')).to.be.true;
        expect(bobLaptop.hasRegisteredUnlockMethod('email')).to.be.true;
        expect(bobLaptop.registeredUnlockMethods).to.deep.have.members([{ type: 'email' }, { type: 'password' }]);
      });
    });

    describe('faulty handlers', () => {
      it('rejects opening without verifying the identity', async () => {
        const signInResult = await bobPhone.signIn(bobIdentity);
        expect(signInResult).to.equal(Tanker.signInResult.IDENTITY_VERIFICATION_NEEDED);
      });
    });

    describe('device unlocking', () => {
      it('can register an unlock password and unlock a new device with it', async () => {
        await expect(bobLaptop.registerUnlock({ password: 'my pass' })).to.be.fulfilled;
        await expect(expectUnlock(bobPhone, bobIdentity, { password: 'my pass' })).to.be.fulfilled;
      });

      it('fails to unlock a new device with a wrong password', async () => {
        await expect(bobLaptop.registerUnlock({ password: 'my pass' })).to.be.fulfilled;
        await expect(expectUnlock(bobPhone, bobIdentity, { password: 'my wrong pass' })).to.be.rejectedWith(errors.InvalidUnlockPassword);
      });

      it('fails to unlock a new device without having registered a password', async () => {
        await expect(expectUnlock(bobPhone, bobIdentity, { password: 'my pass' })).to.be.rejectedWith(errors.InvalidUnlockKey);
      });

      it('can register an unlock password, update it, and unlock a new device with the new password only', async () => {
        await expect(bobLaptop.registerUnlock({ password: 'my pass' })).to.be.fulfilled;
        await expect(bobLaptop.registerUnlock({ password: 'my new pass' })).to.be.fulfilled;

        await expect(expectUnlock(bobPhone, bobIdentity, { password: 'my pass' })).to.be.rejectedWith(errors.InvalidUnlockPassword);
        await bobPhone.signOut();

        await expect(expectUnlock(bobPhone, bobIdentity, { password: 'my new pass' })).to.be.fulfilled;
      });

      it('can register an unlock email and unlock a new device with a valid verification code', async () => {
        await expect(bobLaptop.registerUnlock({ email: 'john@doe.com' })).to.be.fulfilled;
        const verificationCode = await trustchainHelper.getVerificationCode('john@doe.com');
        await expect(expectUnlock(bobPhone, bobIdentity, { verificationCode })).to.be.fulfilled;
      });

      it('fails to unlock a new device with a wrong verification code', async () => {
        await expect(bobLaptop.registerUnlock({ email: 'john@doe.com' })).to.be.fulfilled;
        const correctVerificationCode = await trustchainHelper.getVerificationCode('john@doe.com');
        // introduce a typo on the first digit
        const wrongVerificationCode = (parseInt(correctVerificationCode[0], 10) + 1) % 10 + correctVerificationCode.substring(1);
        await expect(expectUnlock(bobPhone, bobIdentity, { verificationCode: wrongVerificationCode })).to.be.rejectedWith(errors.InvalidVerificationCode);
      });
    });

    describe('advanced device unlocking', () => {
      beforeEach(async () => {
        await expect(bobLaptop.isUnlockAlreadySetUp()).to.be.eventually.false;
        await bobLaptop.generateAndRegisterUnlockKey();
      });

      it('can test if unlock is setup', async () => {
        // synchronously wait for the ghost device creation block
        await bobLaptop._session._trustchain.sync(); // eslint-disable-line no-underscore-dangle

        await expect(bobLaptop.isUnlockAlreadySetUp()).to.be.eventually.true;
      });

      it('should throw a nice error when password is not set', async () => {
        await expect(bobPhone.signIn(bobIdentity, { password: 'noPasswordDefined' })).to.be.rejectedWith(errors.InvalidUnlockKey);
        expect(bobPhone.isOpen).to.be.false;
      });

      it('should throw a nice error when password is not set and email is set', async () => {
        await expect(bobLaptop.registerUnlock({ email: 'john@doe.com' })).to.be.fulfilled;
        await expect(bobPhone.signIn(bobIdentity, { password: 'noPasswordDefined' })).to.be.rejectedWith(errors.InvalidUnlockPassword);
        expect(bobPhone.isOpen).to.be.false;
      });

      it('should throw a nice error when email is not set and password is set', async () => {
        await expect(bobLaptop.registerUnlock({ password: 'noEmail' })).to.be.fulfilled;
        const verificationCode = 'ZW1haWwgbm90IHNldA=='; // any b64 value, will be ignored
        await expect(bobPhone.signIn(bobIdentity, { verificationCode })).to.be.rejectedWith(errors.InvalidVerificationCode);
        expect(bobPhone.isOpen).to.be.false;
      });
    });
  });

  describe('unlock methods in signUp', () => {
    let bobLaptop;
    let bobPhone;
    let bobIdentity;
    let trustchainHelper;

    before(() => {
      ({ bobLaptop, bobPhone, trustchainHelper } = args);
    });

    beforeEach(async () => {
      const bobId = uuid.v4();
      bobIdentity = await trustchainHelper.generateIdentity(bobId);
    });

    afterEach(async () => {
      await Promise.all([
        bobLaptop.signOut(),
        bobPhone.signOut(),
      ]);
    });

    it('should unlock by password', async () => {
      await expect(bobLaptop.signUp(bobIdentity, { password: 'my pass' })).to.be.fulfilled;
      await expect(expectUnlock(bobPhone, bobIdentity, { password: 'my pass' })).to.be.fulfilled;
    });

    it('should unlock by email', async () => {
      await expect(bobLaptop.signUp(bobIdentity, { email: 'john@doe.com' })).to.be.fulfilled;
      const verificationCode = await trustchainHelper.getVerificationCode('john@doe.com');
      await expect(expectUnlock(bobPhone, bobIdentity, { verificationCode })).to.be.fulfilled;
    });
  });
};

export default generateUnlockTests;

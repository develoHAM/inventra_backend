import { FakePhoneVerifier } from './fake.verifier';

describe('FakePhoneVerifier', () => {
  let verifier: FakePhoneVerifier;

  beforeEach(() => {
    verifier = new FakePhoneVerifier();
  });

  it('reports nothing until the "user" texts the code', async () => {
    await expect(verifier.messageExists('01012345678', '482913')).resolves.toBe(
      false,
    );

    verifier.receive('01012345678', '482913');

    await expect(verifier.messageExists('01012345678', '482913')).resolves.toBe(
      true,
    );
  });

  it('matches the text exactly', async () => {
    verifier.receive('01012345678', '482913');

    await expect(verifier.messageExists('01012345678', '482914')).resolves.toBe(
      false,
    );
    await expect(verifier.messageExists('01012345678', '48291')).resolves.toBe(
      false,
    );
  });

  it('only counts texts sent from that phone', async () => {
    verifier.receive('01099998888', '482913');

    await expect(verifier.messageExists('01012345678', '482913')).resolves.toBe(
      false,
    );
  });
});

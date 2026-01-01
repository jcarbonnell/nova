const Nep413MessageSchema = {
  struct: {
    message: "string",
    nonce: { array: { type: "u8", len: 32 } },
    recipient: "string",
    callbackUrl: { option: "string" }
  }
};
class Signer {
}
export {
  Nep413MessageSchema,
  Signer
};

class Enum {
  constructor(properties) {
    if (Object.keys(properties).length !== 1) {
      throw new Error("Enum can only take single value");
    }
    Object.keys(properties).map((key) => {
      this[key] = properties[key];
    });
  }
}
export {
  Enum
};

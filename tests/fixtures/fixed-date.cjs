if (process.env.FIXED_DATE_NOW) {
  const RealDate = Date;
  const fixed = Number(process.env.FIXED_DATE_NOW);
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}

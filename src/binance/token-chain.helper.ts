export type TargetChain = 'ETH' | 'BSC' | 'SOL';

export interface TokenChainMetadata {
  symbol: string;
  chain: TargetChain;
  badge: string;
  chainName: string;
  isMemeOrLowCap: boolean;
}

// 1. Solana Ecosystem Tokens (SPL & Solana Memes)
export const SOL_SYMBOLS = new Set([
  'SOLUSDT', 'JUPUSDT', 'RAYUSDT', 'PYTHUSDT', '1000BONKUSDT', 'BONKUSDT',
  'WIFUSDT', 'BOMEUSDT', 'MEWUSDT', 'POPCATUSDT', 'TNSRUSDT', 'DRIFTUSDT',
  'WUSDT', 'JTOUSDT', 'KMNOUSDT', 'MOODENGUSDT', 'GOATUSDT', 'ACTUSDT',
  'PNUTUSDT', 'PENGUUSDT', 'CHILLGUYUSDT', 'AIXBTUSDT', 'GRASSUSDT', 'FIDAUSDT',
  'RENDERUSDT', 'HNTUSDT', 'STEPUSDT', 'IOUSDT', 'ZEREBROUSDT', 'BANUSDT',
  'FARTCOINUSDT', 'PIPPINUSDT', 'ORCAUSDT', 'SLERFUSDT', 'MYROUSDT', 'PONKEUSDT',
  'SAROSUSDT', 'CWIFUSDT', 'WENUSDT', 'SAMOUSDT', 'SWARMSUSDT', 'GRIFFAINUSDT',
  'SOLVUSDT', 'RESOLVUSDT', 'CHIPUSDT', 'MELANIAUSDT', 'TRUMPUSDT', 'BILLUSDT',
  'BULLAUSDT', 'SIRENUSDT', 'SPKUSDT', 'TACUSDT', 'BASUSDT', 'ARCUSDT',
  'DOODUSDT', 'HAEDALUSDT', 'CYSUSDT', 'ZESTUSDT', 'TRUTHUSDT', 'HEIUSDT',
  'B2USDT', 'KITEUSDT', '0GUSDT', 'ORDERUSDT', 'TOSHIUSDT', 'UAIUSDT',
  'TAGUSDT', 'RIFUSDT', 'GUNUSDT', 'POWERUSDT', 'AKEUSDT', 'MIRAUSDT',
  'TOWNSUSDT', '4USDT', 'BMTUSDT', 'ALLOUSDT', 'SENTUSDT', 'BERAUSDT',
  'BARDUSDT', 'ARIAUSDT', 'AIAUSDT', 'KATUSDT', 'CAPUSDT', 'ACEUSDT',
  'ICNTUSDT', 'AIGENSYNUSDT', 'BIOUSDT', 'KGENUSDT', 'COLLECTUSDT', 'ELSAUSDT',
  'HANAUSDT', 'MAGMAUSDT', 'APRUSDT', 'REDUSDT', 'REUSDT', 'BASEDUSDT',
  'DATAIPUSDT', 'SXTUSDT', 'JELLYJELLYUSDT', 'GUAUSDT', 'NAORISUSDT', 'OPGUSDT',
  'NILUSDT', 'PLUMEUSDT', 'CROSSUSDT', 'PARTIUSDT', 'FIGHTUSDT', 'INXUSDT',
  'SOONUSDT', 'MARSCOINUSDT', 'BLUAIUSDT', 'USELESSUSDT', 'SAPIENUSDT', 'STOUSDT',
  'AVNTUSDT', 'EPICUSDT', 'TSTUSDT', 'HOMEUSDT', 'XPINUSDT', 'COOKIEUSDT',
  'SHELLUSDT', 'OPNUSDT', 'BANANAS31USDT', 'FORMUSDT', 'EDENUSDT', 'TRIAUSDT',
  'AIOTUSDT', 'SQDUSDT', 'SLXUSDT', 'SAHARAUSDT', 'STBLUSDT', 'LINEAUSDT',
  'WALUSDT', 'SKYUSDT', 'ANIMEUSDT', 'JCTUSDT', 'TAKEUSDT', 'CLOUSDT',
  'BROCCOLIF3BUSDT', 'SKRUSDT', 'PIXELUSDT', 'ZKCUSDT', 'KOMAUSDT', 'RECALLUSDT',
  'IRYSUSDT', 'WCTUSDT', 'PTBUSDT', 'MERLUSDT', 'MMTUSDT', 'FOGOUSDT',
  'ZBTUSDT', 'SKYAIUSDT', 'BROCCOLI714USDT', 'BSBUSDT', 'AINUSDT', 'GRVTUSDT',
  'MOCAUSDT', 'ERAUSDT', 'ATHUSDT', 'EDGEUSDT', 'MITOUSDT', 'CGPTUSDT',
  'BREVUSDT', 'AVAAIUSDT', 'BLESSUSDT', 'SOMIUSDT', 'PRLUSDT', 'MONUSDT',
  'SYRUPUSDT', 'NIGHTUSDT', 'PROVEUSDT', 'ESPUSDT', 'VELVETUSDT', 'AGTUSDT',
  'RAVEUSDT', 'AVAUSDT', 'BEAMXUSDT', 'NOMUSDT', '2ZUSDT', 'CHRUSDT', 'COAIUSDT',
  'INUSDT', 'ZKPUSDT', 'SOPHUSDT', 'MEGAUSDT', 'ONUSDT', 'BRETTUSDT',
]);

// 2. BNB Chain (BSC) Ecosystem Tokens (BEP-20 & BSC Memes)
export const BSC_SYMBOLS = new Set([
  '1000FLOKIUSDT', 'FLOKIUSDT', '1MBABYDOGEUSDT', 'BABYDOGEUSDT',
  '1000CHEEMSUSDT', 'CHEEMSUSDT', 'THEUSDT', 'TWTUSDT', 'BAKEUSDT',
  'CAKEUSDT', 'C98USDT', 'LISTAUSDT', 'BBUSDT', 'BELUSDT',
  'ALPACAUSDT', 'BANANAUSDT', 'DODOXUSDT', 'VOXELUSDT', 'MBOXUSDT',
  'REEFUSDT', 'QUICKUSDT', 'BISWAPUSDT', 'BSWUSDT', 'BURGERUSDT',
  'SLFUSDT', 'SFPUSDT', 'HOOKUSDT', 'MUBARAKUSDT', 'COCOUSDT',
  '1000CATUSDT', 'EDUUSDT', 'IDUSDT', 'CTKUSDT', 'PERPUSDT',
  'HARDUSDT', 'CHESSUSDT', 'BIFIUSDT', 'HIGHUSDT', 'SANTOSUSDT',
  'ALPINEUSDT', 'PORTOUSDT', 'LAZIOUSDT', 'CITYUSDT', 'OGUSDT',
  'BARUSDT', 'ATMUSDT', 'ASRUSDT', 'JUVUSDT', 'BTRUSDT',
]);

// 3. Ethereum Ecosystem Tokens (ERC-20 Memes, DeFi, Layer 2s on ETH)
export const ETH_SYMBOLS = new Set([
  '1000PEPEUSDT', 'PEPEUSDT', '1000SHIBUSDT', 'SHIBUSDT', 'PEOPLEUSDT',
  'NEIROETHUSDT', 'NEIROUSDT', 'TURBOUSDT', 'MEMEUSDT', '1000000MOGUSDT',
  'MOGUSDT', 'SPXUSDT', 'LADYSUSDT', 'WOJAKUSDT', 'LDOUSDT', 'RPLUSDT',
  'ENAUSDT', 'ETHFIUSDT', 'PENDLEUSDT', 'UNIUSDT', 'SUSHIUSDT', 'AAVEUSDT',
  'CRVUSDT', 'BALUSDT', 'COMPUSDT', 'ENSUSDT', 'BLURUSDT', 'LOOKSUSDT',
  'STRKUSDT', 'ARBUSDT', 'OPUSDT', 'ZKUSDT', 'TAIKOUSDT', 'SCRUSDT',
  'MANTAUSDT', 'METISUSDT', 'SSVUSDT', 'DYDXUSDT', 'EIGENUSDT', 'COWUSDT',
  'SAFEUSDT', 'REZUSDT', 'SYNUSDT', 'SNXUSDT', '1INCHUSDT', 'LQTYUSDT',
  'FXSUSDT', 'FRAXUSDT', 'YFIUSDT', 'CVXUSDT', 'CHZUSDT', 'BATUSDT',
  'AGLDUSDT', 'SPELLUSDT', 'ILVUSDT', 'GALAUSDT', 'SANDUSDT', 'MANAUSDT',
  'MAGICUSDT', 'AXSUSDT', 'IMXUSDT', 'SUPERUSDT', 'ENJUSDT', 'SKLUSDT',
  'CTSIUSDT', 'RLCUSDT', 'TRUUSDT', 'RADUSDT', 'MASKUSDT', 'DEGENUSDT',
  'AEROUSDT', 'ZORAUSDT', 'BIGTIMEUSDT', 'RONINUSDT', 'YGGUSDT',
  'DARUSDT', 'ALICEUSDT', 'TLMUSDT', 'DUSKUSDT', 'ANKRUSDT',
  'ACHUSDT', 'AUDIOUSDT', 'API3USDT', 'BANDUSDT', 'CVCUSDT', 'DENTUSDT',
  'HOTUSDT', 'IOTXUSDT', 'JASMYUSDT', 'KNCUSDT', 'LRCUSDT', 'MTLUSDT',
  'NKNUSDT', 'OGNUSDT', 'POWRUSDT', 'PUNDIXUSDT', 'QNTUSDT', 'SLPUSDT',
  'STORJUSDT', 'SXPUSDT', 'WOOUSDT', 'WRXUSDT', 'ZRXUSDT', '1000LUNCUSDT',
  'USTCUSDT', '1000RATSUSDT', '1000SATSUSDT',
]);

// Danh sách loại trừ dứt khoát: Major caps, Stablecoins, Stocks và các chain không phải ETH, BSC, SOL
export const EXCLUDED_CHAINS_OR_SYMBOLS = new Set([
  // Major L1s không thuộc ETH/BSC/SOL
  'BTCUSDT', 'TRXUSDT', 'SUNUSDT', 'JSTUSDT', 'ADAUSDT', 'XRPUSDT',
  'DOTUSDT', 'ATOMUSDT', 'SUIUSDT', 'CETUSUSDT', 'DEEPUSDT', 'APTUSDT',
  'NEARUSDT', 'TONUSDT', 'NOTUSDT', 'DOGSUSDT', 'HMSTRUSDT', 'CATIUSDT',
  'FILUSDT', 'ICPUSDT', 'ALGOUSDT', 'HBARUSDT', 'SEIUSDT', 'XTZUSDT',
  'IOTAUSDT', 'EOSUSDT', 'KAVAUSDT', 'CFXUSDT', 'MINAUSDT', 'XLMUSDT',
  'FLOWUSDT', 'KASUSDT', 'LTCUSDT', 'BCHUSDT', 'ETCUSDT', 'RVNUSDT',
  'ZECUSDT', 'DASHUSDT', 'ZENUSDT', 'NEOUSDT', 'GASUSDT',
  // Stablecoins & phái sinh cổ phiếu
  'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT', 'BTCDOMUSDT', 'DEFIUSDT',
  'FOOTBALLUSDT', 'TSLAUSDT', 'INTCUSDT', 'HOODUSDT', 'MSTRUSDT', 'AMZNUSDT',
  'COINUSDT', 'PLTRUSDT', 'METAUSDT', 'NVDAUSDT', 'GOOGLUSDT', 'QQQUSDT',
  'SPYUSDT', 'AAPLUSDT', 'MUUSDT', 'MSFTUSDT', 'AVGOUSDT', 'BABAUSDT',
  'AMDUSDT', 'SOXLUSDT', 'ARMUSDT', 'SKHYNIXUSDT', 'SAMSUNGUSDT',
]);

// Giá trần tối đa theo yêu cầu bắt buộc: Dưới 0.5$ (price < 0.50 USD)
export const MAX_ALLOWED_PRICE = 0.50;

/**
 * Xác định mạng lưới chính (ETH, BSC, SOL) của token.
 */
export function getTokenChain(symbol: string): TargetChain | null {
  const upper = symbol.toUpperCase();

  if (EXCLUDED_CHAINS_OR_SYMBOLS.has(upper)) {
    return null;
  }

  if (SOL_SYMBOLS.has(upper)) {
    return 'SOL';
  }
  if (BSC_SYMBOLS.has(upper)) {
    return 'BSC';
  }
  if (ETH_SYMBOLS.has(upper)) {
    return 'ETH';
  }

  // Nhận diện theo mẫu tên Meme trên các mạng (nếu có coin mới list)
  if (upper.includes('SOL') || upper.endsWith('SOLUSDT')) {
    return 'SOL';
  }
  if (upper.includes('BABY') || upper.includes('FLOKI') || upper.includes('CHEEMS')) {
    return 'BSC';
  }
  if (
    upper.includes('PEPE') ||
    upper.includes('SHIB') ||
    upper.includes('NEIRO') ||
    upper.includes('MOG')
  ) {
    return 'ETH';
  }

  return null;
}

/**
 * Kiểm tra xem token có thuộc 1 trong 3 mạng mục tiêu (ETH, BSC, SOL) hay không.
 */
export function isTargetChain(symbol: string): boolean {
  return getTokenChain(symbol) !== null;
}

/**
 * Trả về badge hiển thị cho từng mạng (e.g. [SOL 🟣], [ETH 🔷], [BSC 🟡]).
 */
export function getChainBadge(symbol: string): string {
  const chain = getTokenChain(symbol);
  switch (chain) {
    case 'SOL':
      return '[SOL 🟣]';
    case 'ETH':
      return '[ETH 🔷]';
    case 'BSC':
      return '[BSC 🟡]';
    default:
      return '';
  }
}

/**
 * Kiểm tra giá token có nghiêm ngặt < 0.5$ hay không.
 */
export function isPriceUnderHalfDollar(price: number): boolean {
  return price > 0 && price < MAX_ALLOWED_PRICE;
}

/**
 * Kiểm tra toàn diện xem token có đủ điều kiện phân tích theo tiêu chuẩn của người dùng:
 * 1. Giá bắt buộc dưới 0.5$ (< 0.5 USD).
 * 2. Đang chạy trên mạng ETH, BSC, hoặc SOL.
 * 3. Không phải stablecoin, cổ phiếu hoặc các chain lớn không liên quan.
 */
export function isEligibleTokenForAlert(symbol: string, currentPrice: number): boolean {
  if (!isPriceUnderHalfDollar(currentPrice)) {
    return false;
  }
  return isTargetChain(symbol);
}

export {
  createDefaultRegistrationConfig,
  parseRegistrationConfig,
  MAX_REGISTRATION_CONFIG_JSON_BYTES,
  MAX_REGISTRATION_CUSTOM_MARKS,
  MAX_REGISTRATION_CUSTOM_PRIMITIVES,
  MAX_REGISTRATION_CUSTOM_PRIMITIVES_PER_MARK,
  MAX_REGISTRATION_CUSTOM_ZONES,
  MAX_REGISTRATION_PAGE_DIMENSION_MM,
} from "./config";
export { generateRegistrationGeometry } from "./geometry";
export { transformRegistrationGeometry } from "./transform";
export type {
  BuiltinRegistrationConfig,
  CustomRegistrationConfig,
  RegistrationCirclePrimitive,
  RegistrationConfig,
  RegistrationGeometryMm,
  RegistrationLinePrimitive,
  RegistrationMarkMm,
  RegistrationOrientation,
  RegistrationPageSizeMm,
  RegistrationPrimitive,
  RegistrationRectMm,
  RegistrationRectanglePrimitive,
  RegistrationType,
} from "./types";
export type { RegistrationReflectionAxis } from "./transform";
export type { BuiltinRegistrationOverrides } from "./config";

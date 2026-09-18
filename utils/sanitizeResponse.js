/**
 * Utility functions to sanitize API responses and prevent PII leakage
 * 
 * CRITICAL: These functions must be used when returning property/host data
 * to prevent leaking sensitive contact information like email, phone, address, dob
 */

// Fields that are safe to expose for host information in public responses
// Show name and profile for display, but NO contact info
const SAFE_HOST_FIELDS = [
  '_id',
  'id',
  'firstName',
  'lastName',
  'languages',
  'profilePicture',
  'about',
  'averageRating',
  'reviewCount',
  'avgPropertyRating',
  'propertyReviewCount',
  'createdAt'
];

// Fields to remove from property responses to prevent contact info leakage
const SENSITIVE_PROPERTY_FIELDS = [
  'hostEmail',
  'validRegistrationNo',
  'bankDetails',
  // Chat-widget vector fields: excluded at the model, stripped again here.
  'embedding',
  'embeddingUpdatedAt',
  'embeddingVersion'
];

// Sensitive fields to remove from property address - keep city/state for display, remove exact location
const SENSITIVE_ADDRESS_FIELDS = [
  'street',
  'registrationNumber'
];

// Fields to remove from host object to prevent PII leakage
const SENSITIVE_HOST_FIELDS = [
  'email',
  'phoneNumber',
  'countryCode',
  'address',
  'dob',
  'otp',
  'otpRetries',
  'lockUntil',
  'tokenVersion',
  'password',
  'verification',
  'preferences',
  'bookings',
  'wishlist',
  'status',
  'bank',
  'kyc',
  'gender',
  'bio',
  'role',
  'hostOffer',
  'updatedAt'
];

/**
 * Sanitize property address by removing sensitive location data
 * @param {Object} address - The address object to sanitize
 * @returns {Object} - Sanitized address with only safe fields (city, state, district, country, pincode)
 */
function sanitizeAddress(address) {
  if (!address) return address;
  
  const addrObj = { ...address };
  
  // Remove sensitive address fields
  SENSITIVE_ADDRESS_FIELDS.forEach(field => {
    delete addrObj[field];
  });
  
  return addrObj;
}

/**
 * Sanitize a host object by removing sensitive fields
 * @param {Object} host - The host object to sanitize
 * @returns {Object} - Sanitized host object with only safe fields
 */
function sanitizeHost(host) {
  if (!host) return host;
  
  const hostObj = host.toObject ? host.toObject() : { ...host };
  
  // Remove sensitive fields
  SENSITIVE_HOST_FIELDS.forEach(field => {
    delete hostObj[field];
  });
  
  return hostObj;
}

/**
 * Sanitize embedded host object (for Property model with embedded host data)
 * @param {Object} host - The embedded host object
 * @returns {Object} - Sanitized host object
 */
function sanitizeEmbeddedHost(host) {
  if (!host) return host;
  
  const hostObj = { ...host };
  
  // Remove contact information from embedded host
  if (hostObj.contact) {
    delete hostObj.contact.phone;
    delete hostObj.contact.email;
    // If contact object is now empty, remove it
    if (Object.keys(hostObj.contact).length === 0) {
      delete hostObj.contact;
    }
  }
  
  return hostObj;
}

/**
 * Sanitize a property object by removing sensitive fields and sanitizing nested host
 * @param {Object} property - The property object to sanitize
 * @returns {Object} - Sanitized property object
 */
function sanitizeProperty(property) {
  if (!property) return property;
  
  const propObj = property.toObject ? property.toObject() : { ...property };
  
  // Remove sensitive property fields
  SENSITIVE_PROPERTY_FIELDS.forEach(field => {
    delete propObj[field];
  });
  
  // Sanitize property address - remove street and registration number but keep city/state/coordinates for map
  if (propObj.address && typeof propObj.address === 'object') {
    propObj.address = sanitizeAddress(propObj.address);
  }
  
  // Sanitize nested host object if present
  if (propObj.host && typeof propObj.host === 'object') {
    if (propObj.host.contact) {
      // Embedded host from Property model
      propObj.host = sanitizeEmbeddedHost(propObj.host);
    } else {
      // Populated host from User model
      propObj.host = sanitizeHost(propObj.host);
    }
  }
  
  return propObj;
}

/**
 * Sanitize an array of properties
 * @param {Array} properties - Array of property objects
 * @returns {Array} - Array of sanitized property objects
 */
function sanitizeProperties(properties) {
  if (!Array.isArray(properties)) return properties;
  return properties.map(sanitizeProperty);
}

/**
 * MongoDB select string for safe host fields when using populate
 * Use this in .populate({ path: 'host', select: SAFE_HOST_SELECT })
 */
const SAFE_HOST_SELECT = SAFE_HOST_FIELDS.join(' ');

module.exports = {
  sanitizeHost,
  sanitizeEmbeddedHost,
  sanitizeProperty,
  sanitizeProperties,
  sanitizeAddress,
  SAFE_HOST_SELECT,
  SAFE_HOST_FIELDS,
  SENSITIVE_PROPERTY_FIELDS,
  SENSITIVE_HOST_FIELDS,
  SENSITIVE_ADDRESS_FIELDS
};

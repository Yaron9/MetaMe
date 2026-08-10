'use strict';

// The protocol is transport/domain-neutral; this narrow re-export keeps the
// Engine-facing import path convenient without duplicating schemas.
module.exports = require('../core/external-adapter-protocol');

/* Relay (TURN) servers for players on strict networks. Used only when a direct connection fails. */
window.RR_ICE = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:europe.relay.metered.ca:80', username: 'd914317352f759feb6d23b43', credential: 'oQd280oFRy2mYeS9' },
  { urls: 'turn:europe.relay.metered.ca:80?transport=tcp', username: 'd914317352f759feb6d23b43', credential: 'oQd280oFRy2mYeS9' },
  { urls: 'turn:europe.relay.metered.ca:443', username: 'd914317352f759feb6d23b43', credential: 'oQd280oFRy2mYeS9' },
  { urls: 'turns:europe.relay.metered.ca:443?transport=tcp', username: 'd914317352f759feb6d23b43', credential: 'oQd280oFRy2mYeS9' }
];

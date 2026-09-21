// Package selfsign mints a throwaway TLS certificate for the test server.
//
// Several of the pages here need a secure context: WebCodecs, Document
// Picture-in-Picture and EME are all gated on it. localhost counts as secure
// even over plain HTTP, but a client on the other side of the lab reaching this
// box by IP does not -- those pages would fail in a way that looks like missing
// browser support rather than a missing scheme. Serving HTTPS with a cert
// covering the host's own addresses avoids chasing that ghost.
package selfsign

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"time"
)

// Cert returns an in-memory certificate valid for localhost plus every
// non-loopback address on this host, so the same binary works over the LAN.
func Cert(extraHosts ...string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}

	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{"testing-video"}, CommonName: "testing-video"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(0, 0, 90),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              append([]string{"localhost"}, extraHosts...),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	for _, ip := range LocalIPs() {
		tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// LocalIPs lists the host's routable addresses, used both for the certificate
// and for printing reachable URLs at startup.
func LocalIPs() []net.IP {
	var out []net.IP
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.IsLoopback() || n.IP.IsLinkLocalUnicast() {
			continue
		}
		if v4 := n.IP.To4(); v4 != nil {
			out = append(out, v4)
		}
	}
	return out
}

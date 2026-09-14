import https = require('https');
import net = require('net');
import express = require('express');
import pify = require('pify');
import pem = require('pem');

export type HttpsServerCertificates = {
	caKey?: Buffer;
	caCert: Buffer;
	serverKey: Buffer;
	serverCert: Buffer;
};

export type HttpsServerOptions = {
	commonName?: string;
	days?: number;
	certificates?: HttpsServerCertificates;
};

export interface ExtendedHttpsTestServer extends express.Express {
	https: https.Server;
	caKey: Buffer;
	caCert: Buffer;
	url: string;
	port: number;
	close: () => Promise<any>;
}

const generateCertificates = async (options: HttpsServerOptions): Promise<HttpsServerCertificates> => {
	const createCSR = pify(pem.createCSR);
	const createCertificate = pify(pem.createCertificate);

	const commonName = options.commonName ?? 'localhost';
	const serverCertificateConfiguration = `
[req]
req_extensions = v3_req
[dn]
CN = ${commonName}
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = ${commonName}
`;
	const caCertificateConfiguration = `
[req]
req_extensions = v3_req
[dn]
CN = authority
[v3_req]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
`;

	const caCSRResult = await createCSR({commonName: 'authority'});
	const caResult = await createCertificate({
		csr: caCSRResult.csr,
		clientKey: caCSRResult.clientKey,
		selfSigned: true,
		config: caCertificateConfiguration
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const serverCSRResult = await createCSR({commonName});
	const serverResult = await createCertificate({
		csr: serverCSRResult.csr,
		clientKey: serverCSRResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert,
		config: serverCertificateConfiguration,
		days: options.days ?? 365
	});
	const serverKey = serverResult.clientKey;
	const serverCert = serverResult.certificate;

	return {caKey, caCert, serverKey, serverCert};
};

const createHttpsTestServer = async (options: HttpsServerOptions = {}): Promise<ExtendedHttpsTestServer> => {
	const {caKey, caCert, serverKey, serverCert} = options.certificates ?? await generateCertificates(options);

	const server = express() as ExtendedHttpsTestServer;
	server.https = https.createServer(
		{
			key: serverKey,
			cert: serverCert,
			ca: caCert,
			requestCert: true,
			rejectUnauthorized: false // This should be checked by the test
		},
		server
	);

	server.set('etag', false);

	await pify(server.https.listen.bind(server.https))();

	server.caKey = caKey!;
	server.caCert = caCert;
	server.port = (server.https.address() as net.AddressInfo).port;
	server.url = `https://localhost:${(server.port)}`;

	server.close = async () => pify(server.https.close.bind(server.https))();

	return server;
};

export default createHttpsTestServer;

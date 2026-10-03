// pando-broker entry point. The broker itself is in BrokerCore.swift; see
// there for what it does and its message format.
//
// Usage:  pando-broker            run as the launchd service
//         pando-broker --ping     check that launchd vends the service
//         pando-broker --version

import Foundation

switch CommandLine.arguments.dropFirst().first {
case nil: runService()
case "--ping": runPing()
case "--version": print("pando-broker \(brokerVersion) (\(serviceName))"); exit(0)
default:
    FileHandle.standardError.write(Data("usage: pando-broker [--ping | --version]\n".utf8))
    exit(2)
}

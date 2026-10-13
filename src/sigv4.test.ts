import { describe, expect, it } from "vitest";
import { amzDate, sha256Hex, sign, uriEncode } from "./sigv4.ts";

const EMPTY = sha256Hex("");

// aws-sig-v4-test-suite (docs.aws.amazon.com, "Signature Version 4 test suite").
const SUITE = {
  region: "us-east-1",
  service: "service",
  keyId: "AKIDEXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  date: new Date("2015-08-30T12:36:00Z"),
};

// S3 developer guide, "Examples: Signature Calculations in AWS Signature Version 4".
const S3 = {
  region: "us-east-1",
  service: "s3",
  keyId: "AKIAIOSFODNN7EXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  date: new Date("2013-05-24T00:00:00Z"),
};

const signature = (auth: string | undefined) => /Signature=([0-9a-f]{64})$/.exec(auth ?? "")?.[1];

describe("sigv4", () => {
  it("get-vanilla", () => {
    const s = sign({
      ...SUITE,
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      payloadHash: EMPTY,
    });
    expect(s.canonicalRequest).toBe(
      `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`,
    );
    expect(sha256Hex(s.canonicalRequest)).toBe(
      "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
    expect(s.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("post-vanilla", () => {
    const s = sign({
      ...SUITE,
      method: "POST",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      payloadHash: EMPTY,
    });
    expect(signature(s.headers.authorization)).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  it("get-vanilla-query-order-key-case", () => {
    const s = sign({
      ...SUITE,
      method: "GET",
      url: new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1"),
      headers: {},
      payloadHash: EMPTY,
    });
    expect(s.canonicalRequest.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(signature(s.headers.authorization)).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("S3 GET Object", () => {
    const s = sign({
      ...S3,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY },
      payloadHash: EMPTY,
    });
    expect(s.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("S3 PUT Object", () => {
    const body = "Welcome to Amazon S3.";
    const hash = sha256Hex(body);
    expect(hash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const s = sign({
      ...S3,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": hash,
      },
      payloadHash: hash,
    });
    expect(s.canonicalRequest.split("\n")[1]).toBe("/test%24file.text");
    expect(signature(s.headers.authorization)).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("encodes the way SigV4 wants", () => {
    expect(uriEncode("a b!'()*~._-")).toBe("a%20b%21%27%28%29%2A~._-");
    expect(amzDate(new Date("2026-10-13T01:02:03.456Z"))).toBe("20261013T010203Z");
  });
});

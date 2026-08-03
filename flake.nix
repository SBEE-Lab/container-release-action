{
  description = "container release action";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      eachSystem =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f {
            inherit system;
            pkgs = nixpkgs.legacyPackages.${system};
          }
        );

      treefmtEval = eachSystem (
        { pkgs, ... }:
        treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs = {
            deadnix.enable = true;
            nixfmt.enable = true;
            statix.enable = true;
          };
        }
      );
    in
    {
      checks = eachSystem (
        { system, ... }:
        {
          formatting = treefmtEval.${system}.config.build.check self;
        }
      );

      formatter = eachSystem ({ system, ... }: treefmtEval.${system}.config.build.wrapper);
    };
}

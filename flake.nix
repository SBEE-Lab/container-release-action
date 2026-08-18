{
  description = "Digest-preserving container release GitHub Action";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
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
            keep-sorted.enable = true;
            nixfmt.enable = true;
            prettier.enable = true;
            statix.enable = true;
          };
          settings.formatter.wrkflw = {
            command = "${pkgs.writeShellScript "wrkflw-with-local-action" ''
              created=
              if [[ ! -e .container-release-action ]]; then
                ln -s . .container-release-action
                created=1
              fi
              cleanup() {
                if [[ -n "$created" ]]; then
                  rm -f .container-release-action
                fi
              }
              trap cleanup EXIT
              ${pkgs.wrkflw}/bin/wrkflw "$@"
            ''}";
            options = [ "validate" ];
            includes = [
              ".github/workflows/*.yaml"
              ".github/workflows/*.yml"
            ];
          };
        }
      );

      action = eachSystem (
        { pkgs, ... }:
        pkgs.buildNpmPackage {
          pname = "container-release-action";
          version = "0.0.0";
          src = self;
          npmDepsHash = "sha256-FivglXK0hOywoajU7KrGS71u+FlZ5zkq4p2jgEZ0lCM=";
          npmBuildScript = "build";
          doCheck = true;
          checkPhase = ''
            runHook preCheck
            npm run check
            diff -ru ${self}/dist dist
            runHook postCheck
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r action.yml dist $out/
            runHook postInstall
          '';
        }
      );
    in
    {
      checks = eachSystem (
        { pkgs, system, ... }:
        {
          action = action.${system};
          formatting = treefmtEval.${system}.config.build.check self;
          workflows =
            pkgs.runCommand "workflow-validation"
              {
                nativeBuildInputs = [
                  pkgs.actionlint
                  pkgs.wrkflw
                ];
              }
              ''
                cp -r ${self} source
                chmod -R u+w source
                cd source
                ln -s . .container-release-action
                actionlint -color -config-file .github/actionlint.yaml \
                  .github/workflows/*.yaml \
                  examples/buildx/*.yaml \
                  examples/multi-image/*.yaml \
                  examples/nix-docker-tools/*.yaml
                wrkflw validate --exit-code \
                  .github/workflows \
                  examples/buildx \
                  examples/multi-image \
                  examples/nix-docker-tools
                touch $out
              '';
        }
      );

      devShells = eachSystem (
        { pkgs, ... }:
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.prefetch-npm-deps
              pkgs.python3
            ];
          };
        }
      );

      formatter = eachSystem ({ system, ... }: treefmtEval.${system}.config.build.wrapper);
      packages = eachSystem (
        { system, ... }:
        {
          default = action.${system};
        }
      );
    };
}
